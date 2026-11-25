import { createHash } from "node:crypto";
import { dataGeneration, getDb } from "./db";
import { getApplicationById, getApplicationSubmission, getApplicationInterviewById, getApplicationAggregateStats, getUpcomingInterviewSummaries, type FunnelMetrics } from "./applications";
import { readProjectMaterialRecord } from "./project-materials";
import { loadResumeForModel } from "./resumes";
import { getHomePriorities } from "./home-priorities";
import { boundMcpOutput } from "./mcp-output";
import { fitPage, pageParams, type PageInput } from "./mcp-read";
import { McpOperationError, type McpErrorCode } from "./mcp-errors";
import { getMcpInterviewQuestionsRecord } from "./mcp-interview-questions";
import { readMcpDraft } from "./mcp-generation";
import { getMcpAiWorkflowContext } from "./mcp-ai";
import { loadMcpPreparationMaterial } from "./mcp-materials";
import { loadMcpReviewAttempt, loadMcpReviewCard, loadMcpReviewSubmission } from "./mcp-review";
import { getNotebookNote } from "./notebook-storage";
import { getNotebookReviewLink } from "./spaced-repetition-cards";
import { readPracticeAnswerContext, readBankEntry, type GradeAccess } from "./mcp-practice";

export const MCP_COLLECTIONS = ["project_materials", "resume_versions", "application_history", "preparation_tasks", "application_interviews", "operation_logs"] as const;
export type McpCollection = typeof MCP_COLLECTIONS[number];
export const MCP_RECORD_KINDS = ["resume", "project", "project_material", "application", "application_submission", "application_interview", "application_interview_questions", "interview", "interview_turn", "practice_session", "practice_question", "interview_review", "notebook", "ai_draft", "resume_diagnosis", "jd_portrait", "intro", "interview_series", "ai_workflow_context", "review_card", "review_attempt", "review_submission", "bank_entry", "practice_answer_context"] as const;
export type McpRecordKind = typeof MCP_RECORD_KINDS[number];

const collections: Record<McpCollection, { sql: string; parent?: string }> = {
  project_materials: { sql: "SELECT id, project_id, title, length(content) AS contentLength, created_at FROM project_materials", parent: "project_id" },
  resume_versions: { sql: "SELECT id, resume_id, version, parent_id, name, description, created_at FROM resume_versions", parent: "resume_id" },
  application_history: { sql: "SELECT id, application_id, from_stage, to_stage, from_hiring_stage, to_hiring_stage, terminal_stage, changed_at, reason FROM application_stage_history", parent: "application_id" },
  preparation_tasks: { sql: "SELECT id, application_id, title, done, due_time, created_at FROM application_preparation_tasks", parent: "application_id" },
  application_interviews: { sql: "SELECT id, application_id, round_name, interview_time, status, interviewer, location, meeting_url, reminder_minutes, notes, created_at, updated_at FROM application_interviews", parent: "application_id" },
  operation_logs: { sql: "SELECT id, request_id, tool, target_id, status, error_code, duration_ms, created_at FROM mcp_operation_logs" },
};

export function listMcpCollection(kind: McpCollection, parentId: number | undefined, input: PageInput) {
  const { limit, idCursor } = pageParams(input);
  const spec = collections[kind];
  if (spec.parent && !parentId) throw new McpOperationError("INVALID_ARGUMENT", "请提供所属记录 ID");
  const args = spec.parent ? [parentId!, idCursor, idCursor, limit + 1] : [idCursor, idCursor, limit + 1];
  const rows = getDb().prepare(`${spec.sql} WHERE ${spec.parent ? `${spec.parent} = ? AND ` : ""}(? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
    .all(...args) as { id: number; [key: string]: unknown }[];
  const items = rows.slice(0, limit).map(row => {
    if (kind === "preparation_tasks") return { ...row, done: Boolean(row.done) };
    if (kind === "application_interviews") return { ...row, fullContent: { tool: "read_record_section", kind: "application_interview", id: row.id } };
    return row;
  });
  return fitPage(items, rows.length > limit ? String(items.at(-1)!.id) : null, item => String(item.id));
}

export function listMcpOperations(input: PageInput & { requestId?: string; tool?: string; errorCode?: McpErrorCode; status?: "success" | "error"; targetId?: number }) {
  const { limit, idCursor } = pageParams(input);
  const where = ["(? IS NULL OR id < ?)"];
  const args: (number | string | null)[] = [idCursor, idCursor];
  for (const [field, value] of [["request_id", input.requestId], ["tool", input.tool], ["error_code", input.errorCode], ["status", input.status], ["target_id", input.targetId]] as const) {
    if (value !== undefined) { where.push(`${field} = ?`); args.push(value); }
  }
  const rows = getDb().prepare(`${collections.operation_logs.sql} WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit + 1) as { id: number; [key: string]: unknown }[];
  const items = rows.slice(0, limit);
  return fitPage(items, rows.length > limit ? String(items.at(-1)!.id) : null, item => String(item.id));
}

function record(kind: McpRecordKind, id: number, versionId?: number, workflowKind?: "jd" | "diagnosis" | "review", interviewId?: number, requestId?: string, timeZone?: string, gradeAccess?: GradeAccess): object | null {
  const db = getDb();
  switch (kind) {
    case "bank_entry": return readBankEntry(id) ?? null;
    case "practice_answer_context": {
      if (!gradeAccess) throw new McpOperationError("FORBIDDEN", "评分依据需要来源权限");
      return readPracticeAnswerContext(id, gradeAccess);
    }
    case "resume": return loadResumeForModel(id, versionId);
    case "application": return getApplicationById(id);
    case "application_submission": return getApplicationSubmission(id);
    case "application_interview": return getApplicationInterviewById(id);
    case "application_interview_questions": return getMcpInterviewQuestionsRecord(id);
    case "project": return db.prepare("SELECT id, name, summary, summary_updated_at, created_at, updated_at FROM projects WHERE id = ?").get(id) ?? null;
    case "project_material": return readProjectMaterialRecord(id);
    case "interview": return db.prepare("SELECT id, resume_id, resume_version_id, series_id, round_no, jd, rounds, style, status, report, reverse_interview, evaluator_report, created_at, finished_at FROM interviews WHERE id = ?").get(id) ?? null;
    case "interview_turn": return db.prepare("SELECT id, interview_id, idx, kind, question, answer, comment, reference, scores, retries, answered_at FROM interview_turns WHERE id = ?").get(id) ?? null;
    case "practice_session": return db.prepare("SELECT id, project_id, interview_id, source, direction, jd, focus, created_at FROM drills WHERE id = ?").get(id) ?? null;
    case "practice_question": return db.prepare("SELECT id, drill_id, idx, kind, question, answer, comment, reference, scores, answered_at FROM drill_questions WHERE id = ?").get(id) ?? null;
    case "interview_review": return db.prepare(`SELECT r.id, r.interview_id, i.application_id, r.input_hash, r.questions, r.result, r.created_at,
      c.company, c.role, c.round_name, c.jd FROM application_interview_recaps r JOIN application_interviews i ON i.id = r.interview_id
      LEFT JOIN application_interview_recap_contexts c ON c.recap_id = r.id WHERE r.id = ?`).get(id) ?? null;
    case "notebook": {
      const row = db.prepare("SELECT id, category_id, source, source_id, source_label, question, answer, comment, reference, scores, created_at, updated_at FROM notebook_entries WHERE id = ?").get(id);
      if (!row) return null;
      const { note, revision } = getNotebookNote(id);
      return { ...row, note, noteRevision: revision, review: getNotebookReviewLink(id) };
    }
    case "ai_draft": return readMcpDraft(id);
    case "resume_diagnosis": case "jd_portrait": case "intro": case "interview_series": return loadMcpPreparationMaterial(kind, id);
    case "review_card": return loadMcpReviewCard(id, timeZone);
    case "review_attempt": return loadMcpReviewAttempt(id);
    case "review_submission": {
      if (!requestId) throw new McpOperationError("INVALID_ARGUMENT", "复习提交需提供 requestId");
      return loadMcpReviewSubmission(id, requestId);
    }
    case "ai_workflow_context": {
      if (!workflowKind) throw new McpOperationError("INVALID_ARGUMENT", "AI 上下文需提供 workflowKind");
      return getMcpAiWorkflowContext(workflowKind, id, interviewId, true);
    }
  }
}

export function getMcpRecord(kind: McpRecordKind, id: number) {
  const value = record(kind, id);
  if (!value) throw new McpOperationError("NOT_FOUND", "记录不存在或已过期");
  return { ...boundMcpOutput(value), fullContent: { tool: "read_record_section", kind, id } };
}

/** UTF-16 offsets are explicit and revision-bound. JSON fragments can be concatenated losslessly. */
export function readMcpRecordSection(input: { kind: McpRecordKind; id: number; versionId?: number; workflowKind?: "jd" | "diagnosis" | "review"; interviewId?: number; requestId?: string; timeZone?: string; offset?: number; length?: number; expectedRevision?: string }, gradeAccess?: GradeAccess) {
  if (input.versionId !== undefined && input.kind !== "resume") throw new McpOperationError("INVALID_ARGUMENT", "versionId 仅用于简历");
  if (input.requestId !== undefined && input.kind !== "review_submission") throw new McpOperationError("INVALID_ARGUMENT", "requestId 仅用于复习提交");
  if (input.timeZone !== undefined && input.kind !== "review_card") throw new McpOperationError("INVALID_ARGUMENT", "timeZone 仅用于复习卡片");
  if (input.kind !== "ai_workflow_context" && (input.workflowKind !== undefined || input.interviewId !== undefined)) throw new McpOperationError("INVALID_ARGUMENT", "workflowKind 与 interviewId 仅用于 AI 上下文");
  if (input.kind === "ai_workflow_context" && (!input.workflowKind || (input.workflowKind === "review" ? !input.interviewId : input.interviewId !== undefined))) throw new McpOperationError("INVALID_ARGUMENT", "复盘上下文需面试 ID，其余上下文不接受面试 ID");
  const value = record(input.kind, input.id, input.versionId, input.workflowKind, input.interviewId, input.requestId, input.timeZone, gradeAccess);
  if (!value) throw new McpOperationError("NOT_FOUND", "记录不存在或已过期");
  const text = JSON.stringify(value);
  const revision = createHash("sha256").update(JSON.stringify([dataGeneration(), input.kind, input.id, input.versionId, text])).digest("hex");
  const offset = input.offset ?? 0;
  if ((offset > 0 && !input.expectedRevision) || (input.expectedRevision && input.expectedRevision !== revision)) {
    throw new McpOperationError("CONFLICT", "资料版本已变化或缺少修订令牌，请从 offset=0 重新读取");
  }
  if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(offset)) && /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)))) {
    throw new McpOperationError("INVALID_ARGUMENT", "分段偏移无效，请使用返回的 nextOffset");
  }
  let end = Math.min(text.length, offset + (input.length ?? 4000));
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end++;
  return { kind: input.kind, id: input.id, revision, encoding: "json/utf-16", offset, text: text.slice(offset, end), totalLength: text.length,
    nextOffset: end < text.length ? end : null };
}

export function getMcpApplicationStats() {
  const { counts, totalActive, rates, funnel, batchStats } = getApplicationAggregateStats();
  // The aggregate capability must not transmit per-application free text (including terminal reasons).
  const metrics = (m: FunnelMetrics) => ({ counts: m.counts, totalApplications: m.totalApplications, totalActive: m.totalActive,
    totalCompleted: m.totalCompleted, totalOffers: m.totalOffers, totalRejected: m.totalRejected, winRate: m.winRate,
    overallYieldRate: m.overallYieldRate, steps: m.steps, hiringSteps: m.hiringSteps, insights: m.insights,
    unknownTerminations: m.unknownTerminations, incompleteHistoryCount: m.incompleteHistoryCount });
  return boundMcpOutput({ counts, totalActive, rates, funnel: metrics(funnel),
    batchStats: batchStats.map(m => ({ batchName: m.batchName, ...metrics(m) })), upcomingInterviews: getUpcomingInterviewSummaries() });
}

export function getMcpPriorities(timeZone?: string) {
  if (timeZone !== undefined) {
    try { new Intl.DateTimeFormat("zh-CN", { timeZone }); }
    catch { throw new McpOperationError("INVALID_ARGUMENT", "时区无效"); }
  }
  return getHomePriorities(new Date(), timeZone);
}
