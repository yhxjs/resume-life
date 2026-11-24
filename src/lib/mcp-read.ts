import { ApplicationInputError, getApplicationById, listApplications } from "@/lib/applications";
import { encodeUpdatedAtCursor, parsePaginationParams, type UpdatedAtCursor } from "@/lib/cursor-pagination";
import { escapeLike, getDb } from "@/lib/db";
import { loadResumeForModel } from "@/lib/resumes";
import { parseSummary } from "@/lib/summary";
import { getPreparationPlan } from "@/lib/preparation-plan";
import { listDrills } from "@/lib/drills-list";
import { boundMcpOutput, MCP_LIST_BUDGET } from "@/lib/mcp-output";
import { mcpRevision } from "@/lib/mcp-revision";
import type { PreparationPlan } from "@/lib/preparation-plan-types";

export const MCP_MAX_PAGE_SIZE = 50;
const TEXT_FIELD_LIMIT = 12_000;
// 搜索、列表和详情共用版本与系列归属，避免标题随草稿变化或轮次失去所属系列。
const INTERVIEW_IDENTITY_COLUMNS = `i.id, i.resume_id,
  COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title,
  i.resume_version_id, rv.version AS resume_version, i.series_id, i.round_no`;
const INTERVIEW_JOINS = `FROM interviews i JOIN resumes r ON r.id = i.resume_id
  LEFT JOIN resume_versions rv ON rv.id = i.resume_version_id`;
const INTERVIEW_DETAIL_COLUMNS = `${INTERVIEW_IDENTITY_COLUMNS},
  i.jd, i.rounds, i.style, i.status, i.report, i.evaluator_report, i.created_at, i.finished_at,
  (SELECT COUNT(*) FROM interview_turns t WHERE t.interview_id = i.id) AS turn_count`;

export function fitPage<T extends object>(items: T[], originalCursor: string | null, cursorOf: (item: T) => string): { items: T[]; nextCursor: string | null } {
  const included: T[] = [];
  for (const row of items) {
    const item = boundMcpOutput(row, 12_000);
    if (JSON.stringify([...included, item]).length > MCP_LIST_BUDGET - 256 && included.length > 0) {
      return { items: included, nextCursor: cursorOf(included[included.length - 1]!) };
    }
    included.push(item);
  }
  return { items: included, nextCursor: originalCursor };
}

export type PageInput = { limit?: number; cursor?: string };

export function pageParams(input: PageInput, kind: "id" | "updatedAt" = "id") {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  const parsed = parsePaginationParams(params, kind);
  if (!parsed.ok) throw new ApplicationInputError("分页参数无效");
  return parsed;
}

function limitedText(value: unknown, limit = TEXT_FIELD_LIMIT): string {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}\n[内容已截断]` : value;
}

function parseJson(value: string, fallback: unknown = null): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return fallback; }
}

function parseJsonLimited(value: string, maxChars: number): unknown {
  if (value.length > maxChars) return { truncated: true, preview: limitedText(value, maxChars) };
  return parseJson(value);
}

export function searchRecords(query: string) {
  const q = query.trim();
  if (q.length < 2 || q.length > 100) throw new Error("搜索词须为 2–100 个字符");
  const db = getDb();
  const like = `%${escapeLike(q)}%`;
  const apps = db.prepare(`SELECT id, company, role, stage, updated_at FROM applications
    WHERE company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR jd LIKE ? ESCAPE '\\'
    ORDER BY updated_at DESC, id DESC LIMIT 5`).all(like, like, like, like);
  const resumes = db.prepare(`SELECT r.id, r.title, r.updated_at FROM resumes r
    WHERE r.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM resume_modules m WHERE m.resume_id = r.id AND m.content LIKE ? ESCAPE '\\')
    ORDER BY r.updated_at DESC, r.id DESC LIMIT 5`).all(like, like);
  const projects = db.prepare(`SELECT p.id, p.name, p.summary_updated_at, p.updated_at FROM projects p
    WHERE p.name LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM project_materials m WHERE m.project_id = p.id AND (m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'))
    ORDER BY p.updated_at DESC, p.id DESC LIMIT 5`).all(like, like, like, like);
  const interviews = db.prepare(`SELECT ${INTERVIEW_IDENTITY_COLUMNS}, i.status, i.style, i.created_at, i.finished_at
    ${INTERVIEW_JOINS}
    WHERE i.jd LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM interview_turns t WHERE t.interview_id = i.id AND
      (t.question LIKE ? ESCAPE '\\' OR t.answer LIKE ? ESCAPE '\\' OR t.comment LIKE ? ESCAPE '\\'))
    ORDER BY i.created_at DESC, i.id DESC LIMIT 5`).all(like, like, like, like);
  const drills = db.prepare(`SELECT DISTINCT d.id, d.source, d.direction, d.focus, d.created_at, p.name AS project_name
    FROM drills d LEFT JOIN projects p ON p.id = d.project_id JOIN drill_questions q ON q.drill_id = d.id
    WHERE d.direction LIKE ? ESCAPE '\\' OR d.jd LIKE ? ESCAPE '\\' OR d.focus LIKE ? ESCAPE '\\' OR
      q.question LIKE ? ESCAPE '\\' OR q.answer LIKE ? ESCAPE '\\'
    ORDER BY d.id DESC LIMIT 5`).all(like, like, like, like, like);
  return boundMcpOutput({ query: q, resumes, projects, applications: apps, interviews, practiceSessions: drills });
}

export function listMcpResumes(input: PageInput = {}) {
  const { limit, idCursor } = pageParams(input);
  const db = getDb();
  const rows = db.prepare(`SELECT id, title, created_at, updated_at FROM resumes
    WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`).all(idCursor, idCursor, limit + 1) as
    { id: number; title: string; created_at: string; updated_at: string }[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const versionQuery = db.prepare(`SELECT id, version, parent_id, name, description, created_at
    FROM resume_versions WHERE resume_id = ? ORDER BY version DESC LIMIT 20`);
  const countQuery = db.prepare("SELECT COUNT(*) AS total FROM resume_versions WHERE resume_id = ?");
  const withVersions = items.map(item => {
    const versions = (versionQuery.all(item.id) as { id: number; version: number; parent_id: number | null; name: string; description: string; created_at: string }[])
      .map(version => ({ ...version, description: limitedText(version.description, 200) }));
    const total = (countQuery.get(item.id) as { total: number }).total;
    return { ...item, versions, versionCount: total, versionsTruncated: total > versions.length };
  });
  const last = items.at(-1);
  const page = fitPage(withVersions, hasMore && last ? String(last.id) : null, item => String(item.id));
  return { ...page, items: page.items.map(item => ({ ...item, versionsTruncated: item.versionCount > item.versions.length })) };
}

export function getMcpResume(id: number, versionId?: number) {
  const resume = loadResumeForModel(id, versionId);
  if (!resume) return null;
  const db = getDb();
  const versions = (db.prepare(`SELECT id, version, parent_id, name, description, created_at FROM resume_versions
    WHERE resume_id = ? ORDER BY version DESC LIMIT 20`).all(id) as { id: number; version: number; parent_id: number | null; name: string; description: string; created_at: string }[])
    .map(version => ({ ...version, description: limitedText(version.description, 200) }));
  const versionCount = (db.prepare("SELECT COUNT(*) AS total FROM resume_versions WHERE resume_id = ?").get(id) as { total: number }).total;
  const result = {
    resume: {
      id: resume.resume.id, title: resume.resume.title, template: resume.resume.template,
      created_at: resume.resume.created_at, updated_at: resume.resume.updated_at,
      version_id: versionId ?? null,
    },
    modules: resume.modules.map(module => ({
      key: module.key, type: module.type, label: module.label,
      content: limitedText(JSON.stringify(module.content), 3_000),
    })),
    warnings: resume.warnings,
    base_version_id: resume.resume.base_version_id ?? null,
    versions, versionCount, versionsTruncated: versionCount > versions.length,
  };
  const bounded = boundMcpOutput(result);
  return { ...bounded, versionsTruncated: versionCount > bounded.versions.length };
}

export function listMcpProjects(input: PageInput = {}) {
  const { limit, idCursor } = pageParams(input);
  const rows = getDb().prepare(`SELECT p.id, p.name, p.summary_updated_at, p.updated_at,
      COUNT(m.id) AS material_count FROM projects p LEFT JOIN project_materials m ON m.project_id = p.id
    WHERE (? IS NULL OR p.id < ?) GROUP BY p.id ORDER BY p.id DESC LIMIT ?`)
    .all(idCursor, idCursor, limit + 1) as { id: number; name: string; summary_updated_at: string; updated_at: string; material_count: number }[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return fitPage(items, hasMore && last ? String(last.id) : null, item => String(item.id));
}

export function getMcpProject(id: number) {
  const db = getDb();
  const project = db.prepare("SELECT id, name, summary, summary_updated_at, created_at, updated_at FROM projects WHERE id = ?").get(id) as
    { id: number; name: string; summary: string; summary_updated_at: string; created_at: string; updated_at: string } | undefined;
  if (!project) return null;
  let summary: unknown = null;
  let summaryWarning: string | null = null;
  try { summary = parseSummary(project.summary); }
  catch { summaryWarning = "项目总结格式损坏，未返回原始存储内容。"; }
  const materials = db.prepare(`SELECT id, title, source, filename, content, created_at FROM project_materials
    WHERE project_id = ? ORDER BY id DESC LIMIT 10`).all(id) as
    { id: number; title: string; source: string; filename: string; content: string; created_at: string }[];
  const materialCount = (db.prepare("SELECT COUNT(*) AS total FROM project_materials WHERE project_id = ?").get(id) as { total: number }).total;
  const bounded = boundMcpOutput({ project: { id, name: project.name, summary, summary_updated_at: project.summary_updated_at,
      created_at: project.created_at, updated_at: project.updated_at, summaryWarning },
    materialCount, hasMoreMaterials: materialCount > materials.length,
    materials: materials.map(item => ({ ...item, content: limitedText(item.content, 2_000) })) });
  return { ...bounded, hasMoreMaterials: materialCount > bounded.materials.length };
}

export function compactMcpApplication(application: NonNullable<ReturnType<typeof getApplicationById>>) {
  const interviews = application.interviews ?? [];
  const history = application.stage_history ?? [];
  const tasks = application.preparation_tasks ?? [];
  return {
    ...application,
    revision: mcpRevision("application", application),
    salary_range: limitedText(application.salary_range, 500),
    jd: limitedText(application.jd, 3_000),
    notes: limitedText(application.notes, 3_000),
    terminal_reason: limitedText(application.terminal_reason, 500),
    ...(interviews.length > 10 || history.length > 20 || tasks.length > 20 ? { truncated: true as const } : {}),
    interviews: interviews.slice(0, 10).map(item => ({ ...item,
      notes: limitedText(item.notes, 500), meeting_url: limitedText(item.meeting_url ?? "", 500),
    })),
    stage_history: history.slice(-20).map(item => ({ ...item, reason: limitedText(item.reason, 500) })),
    preparation_tasks: tasks.slice(0, 20),
  };
}

export function listMcpApplications(input: PageInput & { stage?: string; q?: string } = {}) {
  const parsed = pageParams(input, "updatedAt");
  const page = listApplications({ limit: parsed.limit, cursor: parsed.updatedAtCursor as UpdatedAtCursor | null,
    ...(input.stage ? { stage: input.stage } : {}), ...(input.q ? { q: input.q.slice(0, 100) } : {}) });
  return fitPage(page.items.map(compactMcpApplication), page.nextCursor, item => encodeApplicationCursor(item));
}

function encodeApplicationCursor(item: { updated_at: string; id: number }) {
  return encodeUpdatedAtCursor({ updatedAt: item.updated_at, id: item.id });
}

export function getMcpApplication(id: number) {
  const application = getApplicationById(id);
  if (!application) return null;
  // Derive all previews from the data used for revision. Extra reads can mix a concurrent Web edit into the same response.
  const rounds = application.interviews ?? [];
  const tasks = application.preparation_tasks ?? [];
  const history = (application.stage_history ?? []).toSorted((a, b) =>
    a.changed_at === b.changed_at ? b.id - a.id : a.changed_at < b.changed_at ? 1 : -1);
  return boundMcpOutput({ application: compactMcpApplication(application),
    submissionContent: application.submitted_at === null ? null : { tool: "read_record_section", kind: "application_submission", id },
    ...(history.length > 50 || tasks.length > 100 || rounds.length > 20 ? { truncated: true as const } : {}),
    interviewRounds: rounds.slice(0, 20).map(item => ({ ...item, notes: limitedText(item.notes, 500), meeting_url: limitedText(item.meeting_url ?? "", 500) })),
    history: history.slice(0, 50).map(({ from_stage, to_stage, from_hiring_stage, to_hiring_stage, terminal_stage, changed_at, reason }) =>
      ({ from_stage, to_stage, from_hiring_stage, to_hiring_stage, terminal_stage, changed_at, reason: limitedText(reason, 500) })),
    customTasks: tasks.slice(0, 100) });
}

export function getMcpPreparationPlan(applicationId: number) {
  return compactMcpPreparationPlan(getPreparationPlan(applicationId));
}

export function compactMcpPreparationPlan(plan: PreparationPlan) {
  return boundMcpOutput({ ...plan, revision: mcpRevision("preparation-plan", plan), application: compactMcpApplication(plan.application) },
    undefined, { preserveArrays: true });
}

/** 工作流提示只携带一份岗位上下文；每个步骤及其完成/阻塞状态必须保留。 */
export function getMcpPreparationContext(applicationId: number) {
  const plan = getPreparationPlan(applicationId);
  const app = plan.application;
  return boundMcpOutput({
    application: { id: app.id, company: app.company, role: app.role, stage: app.stage, jd: app.jd, notes: app.notes,
      resume_id: app.resume_id, resume_version_id: app.resume_version_id, next_interview_at: app.next_interview_at },
    preparationPlan: { contextKey: plan.contextKey, generatedAt: plan.generatedAt, stale: plan.stale,
      steps: plan.steps.map(({ key, title, done, blocked, manual, minutes, instructions }) => ({ key, title, done, blocked, manual, minutes, instructions })) },
  }, 5_000, { preserveArrays: true });
}

export function listMcpInterviews(input: PageInput = {}) {
  const { limit, idCursor } = pageParams(input);
  const db = getDb();
  const rows = db.prepare(`SELECT ${INTERVIEW_DETAIL_COLUMNS} ${INTERVIEW_JOINS}
    WHERE (? IS NULL OR i.id < ?) ORDER BY i.id DESC LIMIT ?`)
    .all(idCursor, idCursor, limit + 1) as InterviewRow[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapInterview);
  const last = rows[Math.min(limit, rows.length) - 1];
  return fitPage(items, hasMore && last ? String(last.id) : null, item => String(item.id));
}

type InterviewRow = { id: number; resume_id: number; resume_title: string; resume_version_id: number | null; resume_version: number | null;
  jd: string; rounds: number; style: string; series_id: number | null; round_no: number; status: string; report: string; evaluator_report: string;
  created_at: string; finished_at: string; turn_count: number };
function mapInterview(row: InterviewRow) {
  return { id: row.id, resume_id: row.resume_id, resume_title: row.resume_title,
    resume_version_id: row.resume_version_id, resume_version: row.resume_version,
    jd: limitedText(row.jd, 3_000), rounds: row.rounds, style: row.style, series_id: row.series_id, round_no: row.round_no,
    status: row.status, report: parseJsonLimited(row.report, 4_000), evaluator_report: parseJsonLimited(row.evaluator_report, 4_000),
    turn_count: row.turn_count, created_at: row.created_at, finished_at: row.finished_at };
}

export function getMcpInterview(id: number, input: PageInput = {}) {
  const { limit, idCursor } = pageParams({ ...input, limit: input.limit ?? 5 });
  const db = getDb();
  const row = db.prepare(`SELECT ${INTERVIEW_DETAIL_COLUMNS} ${INTERVIEW_JOINS}
    WHERE i.id = ?`).get(id) as InterviewRow | undefined;
  if (!row) return null;
  const turns = db.prepare(`SELECT id, idx, kind, question, answer, comment, scores, reference, answered_at
    FROM interview_turns WHERE interview_id = ? AND (? IS NULL OR id < ?)
    ORDER BY id DESC LIMIT ?`).all(id, idCursor, idCursor, limit + 1) as
    { id: number; idx: number; kind: string; question: string; answer: string; comment: string; scores: string; reference: string; answered_at: string }[];
  const items = turns.slice(0, limit).map(turn => ({ ...turn,
    question: limitedText(turn.question, 600), answer: limitedText(turn.answer, 600),
    comment: limitedText(turn.comment, 600), reference: limitedText(turn.reference, 600),
    scores: parseJsonLimited(turn.scores, 800) }));
  const last = items.at(-1);
  const page = fitPage(items, turns.length > limit && last ? String(last.id) : null, turn => String(turn.id));
  // 分页已裁剪过回合，不能再对整页截断数组，否则 nextCursor 会跳过未返回记录。
  return { interview: boundMcpOutput(mapInterview(row), 7_000), turns: page.items,
    nextCursor: page.nextCursor, hasMoreTurns: page.nextCursor !== null };
}

export function listMcpInterviewReviews(input: PageInput = {}) {
  const { limit, idCursor } = pageParams(input);
  const rows = getDb().prepare(`SELECT rec.id, rec.interview_id, ai.application_id, ctx.company, ctx.role,
      ctx.round_name, rec.questions, rec.result, rec.created_at, ctx.jd
    FROM application_interview_recaps rec JOIN application_interviews ai ON ai.id = rec.interview_id
    LEFT JOIN application_interview_recap_contexts ctx ON ctx.recap_id = rec.id
    WHERE (? IS NULL OR rec.id < ?) ORDER BY rec.id DESC LIMIT ?`).all(idCursor, idCursor, limit + 1) as
    { id: number; interview_id: number; application_id: number; company: string | null; role: string | null; round_name: string | null;
      questions: string; result: string; created_at: string; jd: string | null }[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(row => ({ ...row, questions: parseJsonLimited(row.questions, 4_000),
    result: parseJsonLimited(row.result, 4_000), jd: row.jd === null ? null : limitedText(row.jd, 2_000) }));
  const last = rows[Math.min(limit, rows.length) - 1];
  return fitPage(items, hasMore && last ? String(last.id) : null, item => String(item.id));
}

type PracticeInput = PageInput & { id?: number; drillId?: number; q?: string; source?: "project" | "bank" | "interview" };

export function listMcpPracticeQuestions(input: PracticeInput = {}) {
  const { limit, idCursor } = pageParams(input);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (input.id !== undefined) { where.push("q.id = ?"); args.push(input.id); }
  if (input.drillId !== undefined) { where.push("q.drill_id = ?"); args.push(input.drillId); }
  if (input.source) { where.push("d.source = ?"); args.push(input.source); }
  if (input.q) {
    const like = `%${escapeLike(input.q.trim().slice(0, 100))}%`;
    where.push("(q.question LIKE ? ESCAPE '\\' OR q.answer LIKE ? ESCAPE '\\' OR q.comment LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (idCursor !== null) { where.push("q.id < ?"); args.push(idCursor); }
  args.push(limit + 1);
  const rows = getDb().prepare(`SELECT q.id, q.drill_id, q.idx, q.question, q.answer, q.comment, q.reference,
      q.scores, q.answered_at, q.kind, d.source, d.direction, d.focus, p.name AS project_name, d.created_at
    FROM drill_questions q JOIN drills d ON d.id = q.drill_id LEFT JOIN projects p ON p.id = d.project_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY q.id DESC LIMIT ?`).all(...args) as
    { id: number; drill_id: number; idx: number; question: string; answer: string; comment: string; reference: string;
      scores: string; answered_at: string; kind: string; source: string; direction: string; focus: string; project_name: string | null; created_at: string }[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(row => ({ ...row, question: limitedText(row.question, 800),
    answer: limitedText(row.answer, 800), comment: limitedText(row.comment, 800), reference: limitedText(row.reference, 800),
    scores: parseJsonLimited(row.scores, 800) }));
  const last = items.at(-1);
  return fitPage(items, hasMore && last ? String(last.id) : null, item => String(item.id));
}

export function getMcpPracticeQuestion(id: number) {
  return listMcpPracticeQuestions({ id, limit: 1 }).items[0] ?? null;
}

export function listMcpDrills(input: PageInput & { projectId?: number; q?: string } = {}) {
  const { limit, idCursor } = pageParams(input);
  const page = listDrills(input.projectId ?? null, input.q?.slice(0, 100) ?? "", idCursor, limit);
  const items = page.items.map(item => ({ ...item, direction: limitedText(item.direction, 500),
    jd: limitedText(item.jd, 1_000), focus: limitedText(item.focus, 500),
    fullContent: { tool: "read_record_section", kind: "practice_session", id: item.id } }));
  return fitPage(items, page.nextCursor, item => String(item.id));
}

export function listMcpNotebook(input: PageInput & { q?: string } = {}) {
  const { limit, idCursor } = pageParams(input);
  const args: (number | string)[] = [];
  const where: string[] = [];
  if (input.q) {
    const like = `%${escapeLike(input.q.trim().slice(0, 100))}%`;
    where.push("(e.question LIKE ? ESCAPE '\\' OR e.answer LIKE ? ESCAPE '\\' OR e.comment LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (idCursor !== null) { where.push("e.id < ?"); args.push(idCursor); }
  args.push(limit + 1);
  const rows = getDb().prepare(`SELECT e.id, e.category_id, c.name AS category_name, e.source, e.source_label,
      e.question, e.answer, e.comment, e.reference, e.scores, e.created_at, e.updated_at
    FROM notebook_entries e LEFT JOIN notebook_categories c ON c.id = e.category_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY e.id DESC LIMIT ?`).all(...args) as
    { id: number; category_id: number | null; category_name: string | null; source: string; source_label: string;
      question: string; answer: string; comment: string; reference: string; scores: string; created_at: string; updated_at: string }[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(row => ({ ...row, question: limitedText(row.question, 800),
    answer: limitedText(row.answer, 800), comment: limitedText(row.comment, 800), reference: limitedText(row.reference, 800),
    scores: parseJsonLimited(row.scores, 800) }));
  const last = items.at(-1);
  return fitPage(items, hasMore && last ? String(last.id) : null, item => String(item.id));
}
