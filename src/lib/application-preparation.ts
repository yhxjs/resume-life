import { getDb, inTransaction, now } from "@/lib/db";
import { linkApplicationNotebooks } from "@/lib/application-notebook";
import { getApplicationById, updateApplication } from "@/lib/applications";
import { createCursorPage } from "@/lib/cursor-pagination";
import { PREPARATION_KINDS, type PreparationKind, type PreparationResource, type PreparationTask } from "@/lib/application-preparation-types";

export class PreparationInputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const SOURCES = {
  diagnosis: { table: "resume_diagnoses", column: "diagnosis_id", title: "job_title", summary: "CASE WHEN json_valid(report) THEN json_extract(report, '$.summary') ELSE '报告无法读取' END", resume: "resume_id" },
  intro: { table: "intros", column: "intro_id", title: "jd", summary: "COALESCE((SELECT group_concat(json_extract(s.value, '$.text'), '') FROM intro_versions v, json_each(CASE WHEN json_valid(v.sentences) THEN v.sentences ELSE '[]' END) s WHERE v.intro_id = r.id AND v.kind = '30s'), '30 秒 / 2 分钟双版')", resume: "resume_id" },
  portrait: { table: "jd_portraits", column: "portrait_id", title: "jd", summary: "CASE WHEN json_valid(result) THEN json_extract(result, '$.role') ELSE '画像无法读取' END", resume: "NULL" },
  interview: { table: "interviews", column: "interview_id", title: "jd", summary: "CASE WHEN status = 'finished' THEN '已完成 · ' ELSE '进行中 · ' END || CASE WHEN json_valid(report) THEN COALESCE(json_extract(report, '$.weaknesses'), '') ELSE '' END", resume: "resume_id" },
  series: { table: "interview_series", column: "series_id", title: "jd", summary: "CASE WHEN status = 'finished' THEN '三轮已完成' ELSE '进阶面试进行中' END", resume: "resume_id" },
  notebook: { table: "notebook_entries", column: "notebook_id", title: "question", summary: "comment", resume: "NULL" },
} as const;

export function parsePreparationKind(value: unknown): PreparationKind {
  if (!PREPARATION_KINDS.includes(value as PreparationKind)) throw new PreparationInputError("无效的资料类型");
  return value as PreparationKind;
}

export function preparationApplication(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new PreparationInputError("无效的投递 ID");
  const application = getApplicationById(id);
  if (!application) throw new PreparationInputError("投递记录不存在或已删除", 404);
  return application;
}

/** 模型调用前校验上下文；保存时再次检查，避免投递变更后归档到错误的岗位。 */
export function resolvePreparationApplication(body: { application_id?: unknown } | null, context: { resumeId?: number; resumeVersionId?: number; jd: string }) {
  if (body?.application_id === undefined) return null;
  if (typeof body.application_id !== "number") throw new PreparationInputError("无效的投递 ID");
  const application = preparationApplication(body.application_id);
  if (context.resumeId !== undefined && context.resumeId !== application.resume_id) throw new PreparationInputError("投递关联简历已变更，请返回准备页刷新", 409);
  if (context.resumeVersionId !== undefined && context.resumeVersionId !== application.resume_version_id) throw new PreparationInputError("投递关联简历版本已变更，请返回准备页刷新", 409);
  if (context.jd.trim() !== application.jd.trim()) throw new PreparationInputError("投递 JD 已变更，请返回准备页刷新", 409);
  return application.id;
}

const NOTEBOOK_SOURCE_ASSOCIATION = `(r.source = 'interview' AND EXISTS (
    SELECT 1 FROM interview_turns t JOIN interviews i ON i.id = t.interview_id
    WHERE t.id = r.source_id AND (
      EXISTS (SELECT 1 FROM applications a WHERE a.id = ? AND (a.interview_id = i.id OR a.interview_series_id = i.series_id)) OR
      EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = ? AND (p.interview_id = i.id OR p.series_id = i.series_id))
    )))`;

function associatedSql(kind: PreparationKind): string {
  const direct = `EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = ? AND p.${SOURCES[kind].column} = r.id)`;
  if (kind === "interview") return `(${direct} OR r.id = (SELECT interview_id FROM applications WHERE id = ?))`;
  if (kind === "series") return `(${direct} OR r.id = (SELECT interview_series_id FROM applications WHERE id = ?))`;
  if (kind === "notebook") return `(${direct} OR ${NOTEBOOK_SOURCE_ASSOCIATION})`;
  return direct;
}

function associationArgs(kind: PreparationKind, applicationId: number) {
  return Array.from({ length: kind === "notebook" ? 3 : kind === "interview" || kind === "series" ? 2 : 1 }, () => applicationId);
}

export function listPreparationResources(applicationId: number, kind: PreparationKind, options: { candidates?: boolean; limit?: number; cursor?: number | null } = {}) {
  const db = getDb();
  const source = SOURCES[kind];
  const limit = options.limit ?? 5;
  const association = associatedSql(kind);
  const where = `${options.candidates ? "NOT" : ""} ${association}${kind === "interview" ? " AND r.series_id IS NULL" : ""}`;
  const args = associationArgs(kind, applicationId);
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM ${source.table} r WHERE ${where}`).get(...args) as { total: number };
  const rows = db.prepare(`SELECT r.id, substr(${source.title}, 1, 120) AS title,
    substr(COALESCE(${source.summary}, ''), 1, 400) AS summary, r.created_at, ${source.resume} AS resume_id,
    ${kind === "notebook" ? `NOT ${NOTEBOOK_SOURCE_ASSOCIATION}` : `EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = ? AND p.${source.column} = r.id)`} AS linked
    FROM ${source.table} r WHERE ${where} ${options.cursor ? "AND r.id < ?" : ""}
    ORDER BY r.id DESC LIMIT ?`).all(...(kind === "notebook" ? [applicationId, applicationId] : [applicationId]), ...args, ...(options.cursor ? [options.cursor] : []), limit + 1) as (Omit<PreparationResource, "href" | "linked"> & { linked: number })[];
  const page = createCursorPage(rows.map((row) => ({ ...row, linked: Boolean(row.linked),
    title: row.title || `记录 #${row.id}`,
    href: kind === "intro" ? `/intros/${row.id}` : kind === "portrait" ? `/tools/jd/${row.id}` :
      kind === "interview" ? `/interviews/${row.id}` : kind === "series" ? `/interviews/series/${row.id}` : null,
  })), limit, (row) => String(row.id));
  return { ...page, total };
}

export function linkPreparationResource(applicationId: number, kind: PreparationKind, resourceId: number): void {
  return inTransaction(() => {
    preparationApplication(applicationId);
    if (!Number.isSafeInteger(resourceId) || resourceId <= 0) throw new PreparationInputError("无效的资料 ID");
    const source = SOURCES[parsePreparationKind(kind)];
    if (!getDb().prepare(`SELECT id FROM ${source.table} WHERE id = ?`).get(resourceId)) throw new PreparationInputError("资料不存在或已删除", 404);
    getDb().prepare(`INSERT OR IGNORE INTO application_preparation_resources (application_id, ${source.column}) VALUES (?, ?)`).run(applicationId, resourceId);
    if (kind === "interview" || kind === "series") linkApplicationNotebooks(getDb(), applicationId);
  });
}

export function unlinkPreparationResource(applicationId: number, kind: PreparationKind, resourceId: number): void {
  const application = preparationApplication(applicationId);
  inTransaction(() => {
    getDb().prepare(`DELETE FROM application_preparation_resources WHERE application_id = ? AND ${SOURCES[parsePreparationKind(kind)].column} = ?`).run(applicationId, resourceId);
    if (kind === "interview" && application.interview_id === resourceId) updateApplication(applicationId, { interview_id: null });
    if (kind === "series" && application.interview_series_id === resourceId) updateApplication(applicationId, { interview_series_id: null });
  });
}

/** 收藏时复制关联，使错题在源面试删除后仍归属原投递。 */
export function linkNotebookToApplications(entryId: number, turnId: number) {
  getDb().prepare(`INSERT OR IGNORE INTO application_preparation_resources (application_id, notebook_id)
    SELECT a.id, ? FROM applications a JOIN interview_turns t ON t.id = ? JOIN interviews i ON i.id = t.interview_id
    WHERE a.interview_id = i.id OR a.interview_series_id = i.series_id OR EXISTS (
      SELECT 1 FROM application_preparation_resources p WHERE p.application_id = a.id AND (p.interview_id = i.id OR p.series_id = i.series_id)
    )`).run(entryId, turnId);
}

export function listPreparationTasks(applicationId: number): PreparationTask[] {
  const rows = getDb().prepare("SELECT id, title, done, due_time, created_at FROM application_preparation_tasks WHERE application_id = ? ORDER BY done, id DESC")
    .all(applicationId) as (Omit<PreparationTask, "done"> & { done: number; due_time?: string })[];
  return rows.map((row) => ({ ...row, done: Boolean(row.done), due_time: row.due_time || "" }));
}

/** 截止时间只接受空值或显式时区的 ISO 时刻，避免 Date 自动修正不存在的日期。 */
export function normalizePreparationDueTime(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new PreparationInputError("无效的截止时间");
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})$/.exec(trimmed);
  if (!parts) throw new PreparationInputError("截止时间需为带时区的有效 ISO 日期时间");
  const wallTime = new Date(`${parts[1]}T${parts[2]}Z`);
  const instant = new Date(trimmed);
  if (!Number.isFinite(wallTime.getTime()) || !Number.isFinite(instant.getTime())
    || wallTime.toISOString().slice(0, 16) !== trimmed.slice(0, 16)) {
    throw new PreparationInputError("无效的截止时间");
  }
  return instant.toISOString();
}

export function createPreparationTask(applicationId: number, title: unknown, dueTime?: unknown) {
  return inTransaction(() => {
    if (typeof title !== "string" || !title.trim() || title.trim().length > 200) throw new PreparationInputError("待办内容需为 1–200 字");
    preparationApplication(applicationId);
    const created_at = now();
    const normalizedDue = normalizePreparationDueTime(dueTime);
    const result = getDb().prepare("INSERT INTO application_preparation_tasks (application_id, title, due_time, created_at) VALUES (?, ?, ?, ?)").run(applicationId, title.trim(), normalizedDue, created_at);
    return { id: Number(result.lastInsertRowid), title: title.trim(), done: false, due_time: normalizedDue, created_at };
  });
}
