import { getDb } from "./db";
import { getReviewDate } from "./spaced-repetition";
import { getReviewDetail, getReviewSubmission, listReviewCards, saveReview } from "./spaced-repetition-cards";
import type { ReviewAttempt, ReviewGrade, ReviewSource } from "./spaced-repetition-card-types";
import { createNotebookFavorite, saveNotebookNote } from "./notebook-storage";
import { mcpCreateOnce } from "./mcp-state";
import { boundMcpOutput } from "./mcp-output";
import { fitPage, pageParams, type PageInput } from "./mcp-read";
import { encodeUpdatedAtCursor } from "./cursor-pagination";
import { McpOperationError } from "./mcp-errors";

function reviewDate(timeZone?: string) {
  try { return getReviewDate(new Date(), timeZone); }
  catch { throw new McpOperationError("INVALID_ARGUMENT", "时区无效"); }
}

export function listMcpReviewCards(input: PageInput & { scope?: "due" | "all"; source?: ReviewSource | "all"; timeZone?: string }) {
  const page = pageParams(input, "updatedAt");
  const result = listReviewCards({ today: reviewDate(input.timeZone), scope: input.scope ?? "due", source: input.source ?? "all", limit: page.limit, cursor: page.updatedAtCursor });
  return { ...fitPage(result.items, result.nextCursor, item => encodeUpdatedAtCursor({ updatedAt: item.sort_date, id: item.id })), summary: result.summary };
}

export function getMcpReviewCard(input: PageInput & { id: number; timeZone?: string }) {
  const { limit, idCursor } = pageParams(input);
  const detail = getReviewDetail(input.id, limit, idCursor, reviewDate(input.timeZone));
  if (!detail) throw new McpOperationError("NOT_FOUND", "复习题目不存在或已删除");
  const attempts = detail.attempts.map(attempt => ({ ...attempt,
    fullContent: { tool: "read_record_section", kind: "review_attempt", id: attempt.id } }));
  const page = fitPage(attempts, detail.nextCursor, item => String(item.id));
  return { ...boundMcpOutput({ ...detail, attempts: [] }), attempts: page.items, nextCursor: page.nextCursor,
    fullContent: { tool: "read_record_section", kind: "review_card", id: input.id,
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }) } };
}

/** 完整卡片资料；复习历史通过 get_review_card 的游标逐页读取。 */
export function loadMcpReviewCard(id: number, timeZone?: string) {
  const detail = getReviewDetail(id, 1, null, reviewDate(timeZone));
  return detail ? Object.fromEntries(Object.entries(detail).filter(([key]) => key !== "attempts" && key !== "nextCursor")) : null;
}

/** 历史摘要的独立完整读取入口，保留提交编号和未裁剪的回答。 */
export function loadMcpReviewAttempt(id: number) {
  return getDb().prepare(`SELECT id, card_id, request_id, answer, grade, reviewed_at, review_date,
    interval_days, next_review_date FROM review_attempts WHERE id=?`).get(id) as
    (ReviewAttempt & { card_id: number; request_id: string; review_date: string }) | undefined ?? null;
}

export function loadMcpReviewSubmission(cardId: number, requestId: string) {
  return getReviewSubmission(cardId, requestId);
}

export function getMcpReviewSubmission(cardId: number, requestId: string) {
  const result = loadMcpReviewSubmission(cardId, requestId);
  if (!result) throw new McpOperationError("NOT_FOUND", "复习提交不存在或已删除");
  return { ...boundMcpOutput(result), fullContent: { tool: "read_record_section", kind: "review_submission", id: cardId, requestId } };
}

export function submitMcpReview(input: { cardId: number; answer: string; grade: ReviewGrade; expectedReviewCount: number; requestId: string; timeZone?: string }) {
  reviewDate(input.timeZone);
  const answer = input.answer.trim();
  if (!answer || answer.length > 20_000 || answer.includes("\u0000")) throw new McpOperationError("INVALID_ARGUMENT", "回答须为 1–20000 字且不能包含空字符");
  const result = mcpCreateOnce("submit_review", input.requestId, { ...input, answer }, () => {
    const saved = saveReview(input.cardId, { answer, grade: input.grade, expected_review_count: input.expectedReviewCount, request_id: input.requestId, time_zone: input.timeZone });
    return { id: saved.attempt.id };
  }, id => Boolean(getDb().prepare("SELECT 1 FROM review_attempts WHERE id=? AND card_id=?").get(id, input.cardId)));
  return { ...result, cardId: input.cardId, requestId: input.requestId };
}

export function bookmarkMcpQuestion(input: { source: "drill" | "interview"; sourceId: number; categoryId?: number | null; idempotencyKey: string }) {
  const { idempotencyKey, ...fields } = input;
  return mcpCreateOnce("bookmark_practice_question", idempotencyKey, fields, () => createNotebookFavorite(fields, true),
    id => Boolean(getDb().prepare("SELECT 1 FROM notebook_entries WHERE id=? AND source=? AND source_id=?").get(id, input.source, input.sourceId)));
}

export function saveMcpNotebookNote(input: { notebookId: number; content: string; expectedRevision: string; idempotencyKey: string }) {
  const { idempotencyKey, ...fields } = input;
  return mcpCreateOnce("save_notebook_note", idempotencyKey, fields, () => ({ id: saveNotebookNote(input.notebookId, input).note!.id }),
    id => Boolean(getDb().prepare("SELECT 1 FROM notebook_notes WHERE id=? AND notebook_id=?").get(id, input.notebookId)));
}
