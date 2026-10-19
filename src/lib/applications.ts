import { escapeLike, getDb, inTransaction, now } from "@/lib/db";
import { linkApplicationNotebooks } from "@/lib/application-notebook";
import { resolveResumeVersionId } from "@/lib/resume-versions";
import { loadResume, type ResumeWithModules } from "@/lib/resumes";
import { assertBackupRecordBytes, BackupLimitError } from "@/lib/backup-limits";
import { calculateBatchFunnelMetrics, calculateFunnelMetrics } from "@/lib/application-funnel";
import {
  createCursorPage,
  encodeUpdatedAtCursor,
  type CursorPage,
  type UpdatedAtCursor,
} from "@/lib/cursor-pagination";
import {
  INTERVIEW_ROUND_STATUSES,
  APPLICATION_STAGES,
  APPLICATION_TERMINAL_STAGES,
  type ApplicationFlowStatus,
  type ApplicationTerminalStage,
  type ApplicationStageHistory,
  type FunnelApplication,
  type Application,
  type ApplicationInterview,
  type ApplicationStage,
  type ApplicationStats,
  type ApplicationResumeSnapshot,
  type ApplicationVersions,
  type CreateApplicationInput,
  type CreateApplicationInterviewInput,
  type InterviewRoundStatus,
  type UpdateApplicationInterviewInput,
} from "@/lib/applications-types";

export * from "@/lib/applications-types";

/**
 * 入参校验失败：路由层据此返回 400，且不写入 server-error 日志。
 * 与之相对，其余异常一律视为内部故障（500 + requestId），避免把持久层错误伪装成 4xx。
 */
export class ApplicationInputError extends Error {}

/** HTTP 与领域写入共用，保证成功保存的 INTEGER 值始终可备份。 */
export function parseInterviewReminderMinutes(value: unknown): number {
  if (value === undefined) return 15;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApplicationInputError("提醒分钟数必须是非负安全整数");
  }
  return value;
}

// 用类型别名而非 interface：类型别名对全部字段都可赋值给 SQLOutputValue 的对象字面量类型
// 会获得隐式索引签名，因此 `all() as RawApplicationRow[]` 是单次断言，无需 `as unknown as`。
type RawApplicationRow = {
  id: number;
  company: string;
  role: string;
  salary_range: string;
  stage: string;
  flow_status: ApplicationFlowStatus;
  batch_name: string;
  hiring_stage: ApplicationTerminalStage | null;
  stage_changed_at: string;
  terminal_stage: ApplicationTerminalStage | null;
  terminal_reason: string;
  terminal_at: string;
  resume_id: number | null;
  resume_version_id: number | null;
  jd: string;
  interview_id: number | null;
  interview_series_id: number | null;
  next_interview_at: string;
  notes: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  resume_title?: string | null;
  interview_rounds?: number | null;
  interview_status?: string | null;
  interview_series_rounds_done?: number | null;
  interview_series_status?: string | null;
};

type RawApplicationInterviewRow = {
  id: number;
  application_id: number;
  round_name: string;
  interview_time: string;
  status: string;
  interviewer: string;
  location?: string;
  meeting_url?: string;
  reminder_minutes?: number;
  notes: string;
  created_at: string;
  updated_at: string;
};

// 看板及统计只读取快照时间，正文在用户回看时按需读取。
const APPLICATION_COLUMNS = `a.id, a.company, a.role, a.salary_range, a.stage,
  a.resume_id, a.resume_version_id, a.jd, a.interview_id, a.interview_series_id, a.next_interview_at,
  a.notes, a.created_at, a.updated_at, a.submitted_at,
  a.flow_status, a.batch_name, a.hiring_stage, a.stage_changed_at,
  a.terminal_stage, a.terminal_reason, a.terminal_at`;

/** 保留 PATCH 的“未提供”语义，非法类型显式返回 400。 */
export function parseApplicationLifecycleInput(body: {
  batch_name?: unknown; hiring_stage?: unknown; terminal_stage?: unknown; terminal_reason?: unknown;
}): Pick<CreateApplicationInput, 'batch_name' | 'hiring_stage' | 'terminal_stage' | 'terminal_reason'> {
  for (const key of ['batch_name', 'terminal_reason'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      throw new ApplicationInputError(key === 'batch_name' ? '投递批次必须是文本' : '终止原因必须是文本');
    }
  }
  for (const key of ['hiring_stage', 'terminal_stage'] as const) {
    if (body[key] !== undefined && body[key] !== null &&
        !APPLICATION_TERMINAL_STAGES.includes(body[key] as ApplicationTerminalStage)) {
      throw new ApplicationInputError('招聘环节无效');
    }
  }
  return {
    batch_name: body.batch_name as string | undefined,
    hiring_stage: body.hiring_stage as ApplicationTerminalStage | null | undefined,
    terminal_stage: body.terminal_stage as ApplicationTerminalStage | null | undefined,
    terminal_reason: body.terminal_reason as string | undefined,
  };
}

function saveLifecycle(id: number, input: Partial<CreateApplicationInput>, existing?: Application): void {
  const stage = input.stage ?? existing?.stage ?? 'interested';
  if (!APPLICATION_STAGES.includes(stage)) throw new ApplicationInputError('投递阶段无效');
  const fields = parseApplicationLifecycleInput(input);
  const batch = (fields.batch_name ?? existing?.batch_name ?? '').trim();
  if (batch.length > 100) throw new ApplicationInputError('投递批次不能超过 100 字');
  const status: ApplicationFlowStatus = stage === 'rejected' ? 'terminated' : stage === 'offer' ? 'passed' : 'active';
  let hiring = fields.hiring_stage !== undefined ? fields.hiring_stage : existing?.hiring_stage ?? null;
  if (fields.hiring_stage === undefined && stage !== existing?.stage) {
    if (stage === 'applied') hiring = 'resume_screening';
    else if (stage === 'interested' || (hiring === 'resume_screening' && ['interviewing', 'interview', 'reviewing'].includes(stage))) hiring = null;
  }
  const wasTerminated = existing?.stage === 'rejected';
  const terminalStage = status === 'terminated'
    ? fields.terminal_stage !== undefined ? fields.terminal_stage : wasTerminated ? existing.terminal_stage : null
    : null;
  const reason = status === 'terminated'
    ? (fields.terminal_reason ?? (wasTerminated ? existing.terminal_reason : '')).trim() : '';
  if (status === 'terminated') {
    if (!terminalStage) throw new ApplicationInputError('请选择终止阶段');
    if (!reason) throw new ApplicationInputError('请填写终止原因');
  }
  if (reason.length > 1000) throw new ApplicationInputError('终止原因不能超过 1000 字');
  if (status === 'terminated') hiring = terminalStage;
  const changed = !existing || stage !== existing.stage || hiring !== existing.hiring_stage;
  const attributionChanged = !!existing && (terminalStage !== existing.terminal_stage || reason !== existing.terminal_reason);
  const ts = now();
  const terminalAt = status === 'terminated' ? wasTerminated ? existing.terminal_at : ts : '';
  const lifecycleChanged = changed || attributionChanged || batch !== existing?.batch_name;
  getDb().prepare(`UPDATE applications SET flow_status = ?, batch_name = ?, hiring_stage = ?,
    stage_changed_at = ?, terminal_stage = ?, terminal_reason = ?, terminal_at = ?,
    updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?`)
    .run(status, batch, hiring, changed ? ts : existing!.stage_changed_at, terminalStage, reason, terminalAt, Number(lifecycleChanged), ts, id);
  if (changed || attributionChanged) {
    getDb().prepare(`INSERT INTO application_stage_history
      (application_id, from_stage, to_stage, from_hiring_stage, to_hiring_stage, terminal_stage, changed_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, existing?.stage ?? null, stage, existing?.hiring_stage ?? null, hiring, terminalStage, ts, reason);
  }
}

function attachStageHistory<T extends FunnelApplication>(apps: T[], all = false): T[] {
  if (!apps.length) return apps;
  const rows = getDb().prepare(`SELECT * FROM application_stage_history
    ${all ? '' : `WHERE application_id IN (${apps.map(() => '?').join(',')})`} ORDER BY id`)
    .all(...(all ? [] : apps.map(a => a.id))) as (ApplicationStageHistory & Record<string, string | number | null>)[];
  const byId = new Map(apps.map(app => [app.id, app]));
  for (const app of apps) app.stage_history = [];
  for (const row of rows) byId.get(row.application_id)?.stage_history?.push(row);
  return apps;
}

function resumeSnapshot(data: ResumeWithModules): ApplicationResumeSnapshot {
  const { id, title, template, style_overrides } = data.resume;
  return {
    id, title, template, style_overrides,
    modules: data.modules.map(({ key, type, label, sort, content }) => ({ key, type, label, sort, content })),
  };
}

/** 仅在首次标记已投递的事务内调用，快照不再随关联记录变化。 */
function captureSubmission(app: Application): void {
  if (app.submitted_at) return;
  const data = app.resume_id === null ? null : loadResume(app.resume_id, app.resume_version_id);
  if (data?.warnings.length) {
    throw new ApplicationInputError("关联简历内容损坏，请修复后再标记已投递");
  }
  getDb().prepare(`UPDATE applications
    SET submitted_at = ?, submitted_resume = ?, submitted_jd = ?
    WHERE id = ? AND submitted_at IS NULL`)
    .run(now(), data ? JSON.stringify(resumeSnapshot(data)) : null, app.jd, app.id);
}

export function getApplicationVersions(id: number): ApplicationVersions | null {
  return inTransaction(() => {
    const row = getDb().prepare(`SELECT resume_id, resume_version_id, jd, submitted_at, submitted_resume, submitted_jd
      FROM applications WHERE id = ?`).get(id) as {
        resume_id: number | null; resume_version_id: number | null; jd: string; submitted_at: string | null;
        submitted_resume: string | null; submitted_jd: string | null;
      } | undefined;
    if (!row) return null;
    const current = row.resume_id === null ? null : loadResume(row.resume_id, row.resume_version_id);
    return {
      submitted: row.submitted_at === null ? null : {
        captured_at: row.submitted_at,
        resume: row.submitted_resume === null ? null : JSON.parse(row.submitted_resume) as ApplicationResumeSnapshot,
        jd: row.submitted_jd ?? "",
      },
      current: { resume: current ? resumeSnapshot(current) : null, jd: row.jd, warnings: current?.warnings ?? [] },
    };
  });
}

function assertSubmissionFitsBackup(id: number): void {
  const row = getDb().prepare("SELECT * FROM applications WHERE id = ? AND submitted_at IS NOT NULL").get(id);
  if (!row) return;
  try {
    // 使用与备份流相同的序列化外层，连同 JD、备注和 JSON 转义开销一起计入。
    assertBackupRecordBytes(Buffer.byteLength(`${JSON.stringify({ kind: "row", table: "applications", data: row })}\n`, "utf8"));
  } catch (error) {
    if (!(error instanceof BackupLimitError)) throw error;
    throw new ApplicationInputError("投递记录（含简历快照）超出备份容量，请精简简历、JD 或备注后重试");
  }
}

function mapRow(r: RawApplicationRow): Application {
  return {
    ...r,
    stage: r.stage as ApplicationStage,
  };
}

function mapInterviewRow(row: RawApplicationInterviewRow): ApplicationInterview {
  return {
    ...row,
    location: row.location ?? "",
    meeting_url: row.meeting_url ?? "",
    reminder_minutes: row.reminder_minutes ?? 15,
    status: row.status as InterviewRoundStatus,
  };
}

function attachInterviews(apps: Application[]): Application[] {
  if (apps.length === 0) return apps;
  const db = getDb();
  const ids = apps.map((a) => a.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM application_interviews WHERE application_id IN (${placeholders}) ORDER BY interview_time ASC, id ASC`
    )
    .all(...ids) as RawApplicationInterviewRow[];

  const map = new Map<number, ApplicationInterview[]>();
  for (const rawRow of rows) {
    const row = mapInterviewRow(rawRow);
    const list = map.get(row.application_id) || [];
    list.push(row);
    map.set(row.application_id, list);
  }

  for (const app of apps) {
    const list = map.get(app.id) || [];
    app.interviews = list;
    app.interview_rounds_count = list.length;
    // 优先显示待面试（scheduled）中最近的，否则显示最后一个已完成的轮次
    const pending = list.find((item) => item.status === "scheduled");
    const latest = pending || (list.length > 0 ? list[list.length - 1] : undefined);
    if (latest) {
      app.latest_round = latest.round_name;
      app.latest_round_status = latest.status;
    }
  }

  // 批量补充准备待办，供日历视图等跨维度联动
  const taskRows = db
    .prepare(
      `SELECT id, application_id, title, done, due_time, created_at FROM application_preparation_tasks WHERE application_id IN (${placeholders}) ORDER BY done ASC, CASE WHEN due_time != '' THEN 0 ELSE 1 END, due_time ASC, id DESC`
    )
    .all(...ids) as { id: number; application_id: number; title: string; done: number; due_time?: string; created_at: string }[];

  const taskMap = new Map<number, { id: number; title: string; done: boolean; due_time?: string; created_at: string }[]>();
  for (const tr of taskRows) {
    const tList = taskMap.get(tr.application_id) || [];
    tList.push({
      id: tr.id,
      title: tr.title,
      done: Boolean(tr.done),
      due_time: tr.due_time || "",
      created_at: tr.created_at,
    });
    taskMap.set(tr.application_id, tList);
  }

  for (const app of apps) {
    app.preparation_tasks = taskMap.get(app.id) || [];
  }

  return attachStageHistory(apps);
}

export function listApplications(options?: {
  stage?: string;
  q?: string;
  upcomingOnly?: boolean;
  limit?: number;
  cursor?: UpdatedAtCursor | null;
}): CursorPage<Application> {
  const db = getDb();
  const cursorIndex = options?.stage && options.stage !== "all"
    ? "idx_applications_stage_updated_at_id"
    : "idx_applications_updated_at_id";
  let sql = `
    SELECT
      ${APPLICATION_COLUMNS},
      COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, rv.version AS resume_version, rv.name AS resume_version_name,
      i.rounds AS interview_rounds,
      i.status AS interview_status,
      s.rounds AS interview_series_rounds_done,
      s.status AS interview_series_status
    FROM applications a INDEXED BY ${cursorIndex}
    LEFT JOIN resumes r ON a.resume_id = r.id
    LEFT JOIN resume_versions rv ON a.resume_version_id = rv.id
    LEFT JOIN interviews i ON a.interview_id = i.id
    LEFT JOIN interview_series s ON a.interview_series_id = s.id
    WHERE 1=1
  `;
  const params: (string | number | null)[] = [];

  if (options?.stage && options.stage !== "all") {
    sql += ` AND a.stage = ?`;
    params.push(options.stage);
  }

  if (options?.q?.trim()) {
    const term = `%${escapeLike(options.q.trim())}%`;
    sql += ` AND (a.company LIKE ? ESCAPE '\\' OR a.role LIKE ? ESCAPE '\\' OR a.notes LIKE ? ESCAPE '\\')`;
    params.push(term, term, term);
  }

  if (options?.upcomingOnly) {
    const currentIso = new Date().toISOString();
    sql += ` AND a.next_interview_at >= ?`;
    params.push(currentIso);
  }

  if (options?.cursor) {
    sql += ` AND (a.updated_at, a.id) < (?, ?)`;
    params.push(options.cursor.updatedAt, options.cursor.id);
  }

  const limit = options?.limit ?? 50;
  sql += ` ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`;
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as RawApplicationRow[];
  const mapped = attachInterviews(rows.map(mapRow));
  return createCursorPage(mapped, limit, (application) =>
    encodeUpdatedAtCursor({ updatedAt: application.updated_at, id: application.id })
  );
}

export function getApplicationById(id: number): Application | null {
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT
      ${APPLICATION_COLUMNS},
      COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, rv.version AS resume_version, rv.name AS resume_version_name,
      i.rounds AS interview_rounds,
      i.status AS interview_status,
      s.rounds AS interview_series_rounds_done,
      s.status AS interview_series_status
    FROM applications a
    LEFT JOIN resumes r ON a.resume_id = r.id
    LEFT JOIN resume_versions rv ON a.resume_version_id = rv.id
    LEFT JOIN interviews i ON a.interview_id = i.id
    LEFT JOIN interview_series s ON a.interview_series_id = s.id
    WHERE a.id = ?
  `
    )
    .get(id) as RawApplicationRow | undefined;

  if (!row) return null;
  const mapped = attachInterviews([mapRow(row)]);
  return mapped[0] || null;
}

export function createApplication(input: CreateApplicationInput): Application {
  return inTransaction(() => {
    const app = insertApplication(input);
    linkApplicationNotebooks(getDb(), app.id);
    saveLifecycle(app.id, input);
    if (app.stage === "applied") captureSubmission(app);
    assertSubmissionFitsBackup(app.id);
    return getApplicationById(app.id)!;
  });
}

/** company/role 一类短字段与 jd/notes 一类长字段的入库上限：误粘贴的超长文本会原样进入列表与日历渲染 */
export const MAX_APPLICATION_ACTOR_CHARS = 200;
export const MAX_APPLICATION_NOTE_CHARS = 20_000;

/** 与界面输入能力匹配的入库上限；超限属于输入错误，走统一的 400 通道 */
function assertApplicationTextLimits(partial: Partial<CreateApplicationInput>): void {
  if (typeof partial.company === "string" && partial.company.trim().length > MAX_APPLICATION_ACTOR_CHARS) {
    throw new ApplicationInputError(`公司名称不能超过 ${MAX_APPLICATION_ACTOR_CHARS} 字`);
  }
  if (typeof partial.role === "string" && partial.role.trim().length > MAX_APPLICATION_ACTOR_CHARS) {
    throw new ApplicationInputError(`岗位名称不能超过 ${MAX_APPLICATION_ACTOR_CHARS} 字`);
  }
  if (typeof partial.jd === "string" && partial.jd.length > MAX_APPLICATION_NOTE_CHARS) {
    throw new ApplicationInputError(`JD 内容不能超过 ${MAX_APPLICATION_NOTE_CHARS} 字`);
  }
  if (typeof partial.notes === "string" && partial.notes.length > MAX_APPLICATION_NOTE_CHARS) {
    throw new ApplicationInputError(`备注不能超过 ${MAX_APPLICATION_NOTE_CHARS} 字`);
  }
}

function insertApplication(input: CreateApplicationInput): Application {
  assertApplicationTextLimits(input);
  const company = input.company.trim();
  const role = input.role.trim();
  if (!company) throw new ApplicationInputError("公司名称不能为空");
  if (!role) throw new ApplicationInputError("岗位名称不能为空");

  const stage = input.stage || "interested";
  const salaryRange = input.salary_range?.trim() || "";
  const resumeId = input.resume_id ? Number(input.resume_id) : null;
  if (resumeId === null && input.resume_version_id != null) throw new ApplicationInputError("请选择版本所属的简历");
  const resumeVersionId = resumeId === null ? null : resolveResumeVersionId(resumeId, input.resume_version_id);
  const jd = input.jd?.trim() || "";
  const interviewId = input.interview_id ? Number(input.interview_id) : null;
  const seriesId = input.interview_series_id ? Number(input.interview_series_id) : null;
  const nextInterviewAt = input.next_interview_at?.trim() || "";
  const notes = input.notes?.trim() || "";
  const ts = now();

  const db = getDb();
  const res = db
    .prepare(
      `
    INSERT INTO applications (
      company, role, salary_range, stage, resume_id, resume_version_id, jd,
      interview_id, interview_series_id, next_interview_at, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      company,
      role,
      salaryRange,
      stage,
      resumeId,
      resumeVersionId,
      jd,
      interviewId,
      seriesId,
      nextInterviewAt,
      notes,
      ts,
      ts
    );

  const inserted = getApplicationById(Number(res.lastInsertRowid));
  if (!inserted) throw new Error("创建投递记录失败");
  return inserted;
}

export function updateApplication(
  id: number,
  partial: Partial<CreateApplicationInput>
): Application {
  return inTransaction(() => {
    const existing = getApplicationById(id);
    if (!existing) throw new ApplicationInputError("未找到对应投递记录");
    const updated = updateApplicationFields(id, partial, existing);
    if (partial.interview_id !== undefined || partial.interview_series_id !== undefined) linkApplicationNotebooks(getDb(), id);
    saveLifecycle(id, partial, existing);
    if (existing.stage !== "applied" && updated.stage === "applied") captureSubmission(updated);
    assertSubmissionFitsBackup(id);
    return getApplicationById(id)!;
  });
}

function updateApplicationFields(
  id: number,
  partial: Partial<CreateApplicationInput>,
  existing: Application,
): Application {
  assertApplicationTextLimits(partial);
  const db = getDb();
  const fields: string[] = [];
  const params: (string | number | null)[] = [];

  if (typeof partial.company === "string") {
    const comp = partial.company.trim();
    if (!comp) throw new ApplicationInputError("公司名称不能为空");
    fields.push("company = ?");
    params.push(comp);
  }

  if (typeof partial.role === "string") {
    const r = partial.role.trim();
    if (!r) throw new ApplicationInputError("岗位名称不能为空");
    fields.push("role = ?");
    params.push(r);
  }

  if (typeof partial.salary_range === "string") {
    fields.push("salary_range = ?");
    params.push(partial.salary_range.trim());
  }

  if (typeof partial.stage === "string") {
    fields.push("stage = ?");
    params.push(partial.stage);
  }

  if (partial.resume_id !== undefined || partial.resume_version_id !== undefined) {
    const resumeId = partial.resume_id !== undefined ? partial.resume_id : existing.resume_id;
    if (resumeId === null && partial.resume_version_id != null) throw new ApplicationInputError("请选择版本所属的简历");
    const versionId = resumeId === null ? null :
      partial.resume_version_id === undefined && resumeId === existing.resume_id && existing.resume_version_id
        ? existing.resume_version_id : resolveResumeVersionId(resumeId, partial.resume_version_id);
    fields.push("resume_id = ?", "resume_version_id = ?");
    params.push(resumeId, versionId);
  }

  if (typeof partial.jd === "string") {
    fields.push("jd = ?");
    params.push(partial.jd.trim());
  }

  if (partial.interview_id !== undefined) {
    fields.push("interview_id = ?");
    params.push(partial.interview_id ? Number(partial.interview_id) : null);
  }

  if (partial.interview_series_id !== undefined) {
    fields.push("interview_series_id = ?");
    params.push(partial.interview_series_id ? Number(partial.interview_series_id) : null);
  }

  if (typeof partial.next_interview_at === "string") {
    fields.push("next_interview_at = ?");
    params.push(partial.next_interview_at.trim());
  }

  if (typeof partial.notes === "string") {
    fields.push("notes = ?");
    params.push(partial.notes.trim());
  }

  if (fields.length === 0) {
    return existing;
  }

  fields.push("updated_at = ?");
  params.push(now());
  params.push(id);

  db.prepare(`UPDATE applications SET ${fields.join(", ")} WHERE id = ?`).run(...params);

  const updated = getApplicationById(id);
  if (!updated) throw new Error("更新投递记录失败");
  return updated;
}

export function deleteApplication(id: number): boolean {
  return inTransaction(() => {
    const db = getDb();
    return db.prepare(`DELETE FROM applications WHERE id = ?`).run(id).changes > 0;
  });
}

export function listApplicationInterviews(applicationId: number): ApplicationInterview[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM application_interviews WHERE application_id = ? ORDER BY interview_time ASC, id ASC`
    )
    .all(applicationId) as RawApplicationInterviewRow[];
  return rows.map(mapInterviewRow);
}

export function getApplicationInterviewById(id: number): ApplicationInterview | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM application_interviews WHERE id = ?`)
    .get(id) as RawApplicationInterviewRow | undefined;
  return row ? mapInterviewRow(row) : null;
}

export function syncApplicationNextInterview(applicationId: number): void {
  return inTransaction(() => {
    const db = getDb();
    const nowIso = new Date().toISOString();
    // 查找还未完成的待面试（scheduled）且带时间的轮次，优先未过期的，其次最早的 scheduled
    const pendingRow = db
      .prepare(
        `SELECT interview_time FROM application_interviews
         WHERE application_id = ? AND status = 'scheduled' AND interview_time != ''
         ORDER BY CASE WHEN interview_time >= ? THEN 0 ELSE 1 END, interview_time ASC
         LIMIT 1`
      )
      .get(applicationId, nowIso) as { interview_time: string } | undefined;

    const nextTime = pendingRow ? pendingRow.interview_time : "";
    db.prepare(`UPDATE applications SET next_interview_at = ?, updated_at = ? WHERE id = ?`).run(
      nextTime,
      now(),
      applicationId
    );
  });
}

export function createApplicationInterview(
  applicationId: number,
  input: CreateApplicationInterviewInput,
  options: { advanceStage?: boolean } = {},
): ApplicationInterview {
  return inTransaction(() => {
    const app = getApplicationById(applicationId);
    if (!app) throw new ApplicationInputError("未找到对应投递记录");

    const roundName = input.round_name?.trim();
    if (!roundName) throw new ApplicationInputError("面试轮次名称不能为空");

    const status = input.status || "scheduled";
    if (!INTERVIEW_ROUND_STATUSES.includes(status)) {
      throw new ApplicationInputError("面试轮次状态无效");
    }

    const interviewTime = input.interview_time?.trim() || "";
    const interviewer = input.interviewer?.trim() || "";
    const location = input.location?.trim() || "";
    const meetingUrl = input.meeting_url?.trim() || "";
    const reminderMinutes = parseInterviewReminderMinutes(input.reminder_minutes);
    const notes = input.notes?.trim() || "";
    const ts = now();

    const db = getDb();
    const res = db
      .prepare(
        `INSERT INTO application_interviews (
          application_id, round_name, interview_time, status, interviewer, location, meeting_url, reminder_minutes, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(applicationId, roundName, interviewTime, status, interviewer, location, meetingUrl, reminderMinutes, notes, ts, ts);

    const newId = Number(res.lastInsertRowid);
    syncApplicationNextInterview(applicationId);

    // 轮次、下次面试时间、阶段及阶段历史属于一次用户操作，共享外层事务。
    if (options.advanceStage && ["interested", "applied", "interviewing"].includes(app.stage)) {
      updateApplication(applicationId, { stage: "interview" });
    }

    const inserted = getApplicationInterviewById(newId);
    if (!inserted) throw new Error("创建面试轮次记录失败");
    return inserted;
  });
}

export function updateApplicationInterview(
  id: number,
  partial: UpdateApplicationInterviewInput
): ApplicationInterview {
  return inTransaction(() => {
    const existing = getApplicationInterviewById(id);
    if (!existing) throw new ApplicationInputError("未找到对应面试轮次记录");

    const db = getDb();
    const fields: string[] = [];
    const params: (string | number | null)[] = [];

    if (typeof partial.round_name === "string") {
      const r = partial.round_name.trim();
      if (!r) throw new ApplicationInputError("面试轮次名称不能为空");
      fields.push("round_name = ?");
      params.push(r);
    }

    if (typeof partial.status === "string") {
      if (!INTERVIEW_ROUND_STATUSES.includes(partial.status as InterviewRoundStatus)) {
        throw new ApplicationInputError("面试轮次状态无效");
      }
      fields.push("status = ?");
      params.push(partial.status);
    }

    if (typeof partial.interview_time === "string") {
      fields.push("interview_time = ?");
      params.push(partial.interview_time.trim());
    }

    if (typeof partial.interviewer === "string") {
      fields.push("interviewer = ?");
      params.push(partial.interviewer.trim());
    }

    if (typeof partial.location === "string") {
      fields.push("location = ?");
      params.push(partial.location.trim());
    }

    if (typeof partial.meeting_url === "string") {
      fields.push("meeting_url = ?");
      params.push(partial.meeting_url.trim());
    }

    if (partial.reminder_minutes !== undefined) {
      fields.push("reminder_minutes = ?");
      params.push(parseInterviewReminderMinutes(partial.reminder_minutes));
    }

    if (typeof partial.notes === "string") {
      fields.push("notes = ?");
      params.push(partial.notes.trim());
    }

    if (fields.length > 0) {
      fields.push("updated_at = ?");
      params.push(now());
      params.push(id);
      db.prepare(`UPDATE application_interviews SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    }

    syncApplicationNextInterview(existing.application_id);

    const updated = getApplicationInterviewById(id);
    if (!updated) throw new Error("更新面试轮次记录失败");
    return updated;
  });
}

export function deleteApplicationInterview(id: number): void {
  return inTransaction(() => {
    const existing = getApplicationInterviewById(id);
    if (!existing) return;
    const db = getDb();
    db.prepare(`DELETE FROM application_interviews WHERE id = ?`).run(id);
    syncApplicationNextInterview(existing.application_id);
  });
}

export function getApplicationStats(): ApplicationStats {
  const db = getDb();
  // 统计从全量轻量履历读取，不受看板分页或当前搜索结果限制。
  const applications = attachStageHistory(db.prepare(`SELECT id, stage, batch_name, hiring_stage,
    terminal_stage, terminal_reason FROM applications ORDER BY id`).all() as Omit<FunnelApplication, 'stage_history'>[], true);
  const funnel = calculateFunnelMetrics(applications);
  const { counts, totalActive } = funnel;
  const appliedRate = funnel.steps.find(s => s.stage === 'interested')?.conversionRate ?? 0;
  const interviewRate = funnel.hiringSteps.find(s => s.stage === 'resume_screening')?.conversionRate ?? 0;
  const offerRate = funnel.winRate;

  // 查询未来 7 天待办面试
  const nowIso = new Date().toISOString();
  const future7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const upcomingRows = db
    .prepare(
      `
    SELECT
      ${APPLICATION_COLUMNS},
      COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, rv.version AS resume_version, rv.name AS resume_version_name,
      i.rounds AS interview_rounds,
      i.status AS interview_status,
      s.rounds AS interview_series_rounds_done,
      s.status AS interview_series_status
    FROM applications a
    LEFT JOIN resumes r ON a.resume_id = r.id
    LEFT JOIN resume_versions rv ON a.resume_version_id = rv.id
    LEFT JOIN interviews i ON a.interview_id = i.id
    LEFT JOIN interview_series s ON a.interview_series_id = s.id
    WHERE a.next_interview_at >= ? AND a.next_interview_at <= ? AND a.stage != 'rejected'
    ORDER BY a.next_interview_at ASC
  `
    )
    .all(nowIso, future7d) as RawApplicationRow[];

  return {
    counts,
    totalActive,
    funnel,
    batchStats: calculateBatchFunnelMetrics(applications),
    upcomingInterviews: attachInterviews(upcomingRows.map(mapRow)),
    rates: {
      appliedRate,
      interviewRate,
      offerRate,
    },
  };
}
