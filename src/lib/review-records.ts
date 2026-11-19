import { REVIEW_GRADE_LABELS, REVIEW_MASTERY_LABELS, type ReviewAttempt, type ReviewCard, type ReviewDetail, type ReviewGrade, type ReviewList, type ReviewListCard, type ReviewSource } from "./spaced-repetition-card-types";
import { decodeUpdatedAtCursor, isCalendarDate } from "./cursor-pagination";

export type ReviewSubmission = { card: ReviewCard; attempt: ReviewAttempt };
export type ReviewSubmissionInput = { cardId: number; answer: string; grade: ReviewGrade; expectedReviewCount: number; timeZone: string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveId = (value: unknown): value is number => integer(value) && value > 0;
function isCard(value: unknown, id: number): value is ReviewCard & Record<string, unknown> {
  return record(value) && positiveId(value.id) && value.id === id && positiveId(value.source_id) &&
    (value.source === "notebook" || value.source === "remedial") &&
    ["source_label", "question", "next_review_date", "last_reviewed_at"].every(key => typeof value[key] === "string") &&
    ["interval_days", "repetitions", "review_count", "lapses"].every(key => integer(value[key])) && positiveId(value.ease_factor) &&
    typeof value.mastery === "string" && Object.hasOwn(REVIEW_MASTERY_LABELS, value.mastery);
}
function isAttempt(value: unknown): value is ReviewAttempt {
  return record(value) && positiveId(value.id) && integer(value.interval_days) &&
    ["answer", "reviewed_at", "next_review_date"].every(key => typeof value[key] === "string") &&
    typeof value.grade === "string" && Object.hasOwn(REVIEW_GRADE_LABELS, value.grade);
}

/** 读取存档协议，不用新回答的篇幅限制清洗历史原文与日期字面量。 */
export function readReviewDetail(value: unknown, id: number, cursor?: string): ReviewDetail {
  const fail = () => { throw new Error("复习读取响应不完整或题目不符，请重新读取"); };
  if (!isCard(value, id) || !record(value) || !["answer", "reference", "comment"].every(key => typeof value[key] === "string") ||
    !Array.isArray(value.attempts) || value.attempts.length > 20 || (value.nextCursor !== null && typeof value.nextCursor !== "string")) return fail();
  let previousId = cursor === undefined ? Infinity : Number(cursor);
  if (cursor !== undefined && (!positiveId(previousId) || String(previousId) !== cursor)) return fail();
  for (const attempt of value.attempts) {
    if (!isAttempt(attempt) || attempt.id >= previousId) return fail();
    previousId = attempt.id;
  }
  if (value.nextCursor !== null && (value.attempts.length === 0 || value.nextCursor !== String(value.attempts.at(-1).id))) return fail();
  return value as ReviewDetail;
}

/** 幂等重放可返回更新后的当前排期；确认的是本次原答与自评对应的同一条历史。 */
export function readReviewSubmission(value: unknown, input: ReviewSubmissionInput, requestId?: string): ReviewSubmission {
  if (!record(value) || !isCard(value.card, input.cardId) || value.card.review_count <= input.expectedReviewCount ||
    !isAttempt(value.attempt) || value.attempt.answer !== input.answer.trim() || value.attempt.grade !== input.grade ||
    (requestId !== undefined && value.request_id !== requestId)) throw new Error("复习保存响应不完整或提交不符");
  return { card: value.card, attempt: value.attempt };
}

type ReviewListQuery = { scope: "due" | "all"; source: ReviewSource | "all"; limit: number; date: string; cursor?: string };
const listFailure = () => { throw new Error("复习列表响应不完整或分页不符，请重新读取"); };
function compareCards(left: Pick<ReviewListCard, "sort_date" | "id">, right: Pick<ReviewListCard, "sort_date" | "id">): number {
  return left.sort_date < right.sort_date ? -1 : left.sort_date > right.sort_date ? 1 : left.id - right.id;
}

/** 整页确认筛选、统计、真实排序和尾游标；不裁切历史原文。 */
export function readReviewList(value: unknown, query: ReviewListQuery): ReviewList {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > query.limit || !record(value.summary) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")) return listFailure();
  const summary = value.summary;
  if (!isCalendarDate(summary.date) || summary.date !== query.date ||
    !["total", "due", "notebook", "remedial", "overdue", "completed_today"].every(key => integer(summary[key]))) return listFailure();
  const counts = summary as ReviewList["summary"];
  if (counts.due > counts.total || counts.overdue > counts.due || counts.completed_today > counts.total || counts.notebook + counts.remedial !== counts.due ||
    value.items.length > (query.scope === "all" ? counts.total : query.source === "all" ? counts.due : counts[query.source])) return listFailure();
  if (query.cursor === undefined && value.items.length === 0 &&
    (query.scope === "all" && query.source === "all" ? counts.total : query.source === "all" ? counts.due : counts[query.source]) > 0) return listFailure();
  const boundary = query.cursor === undefined ? null : decodeUpdatedAtCursor(query.cursor);
  if (boundary && !isCalendarDate(boundary.updatedAt)) return listFailure();
  let previous = boundary ? { sort_date: boundary.updatedAt, id: boundary.id } : null;
  const ids = new Set<number>();
  for (const item of value.items) {
    if (!record(item) || !positiveId(item.id) || !isCard(item, item.id) || !isCalendarDate(item.sort_date) || !isCalendarDate(item.next_review_date) ||
      (query.source !== "all" && item.source !== query.source) ||
      (item.review_count === 0 ? item.next_review_date !== query.date : item.next_review_date !== item.sort_date) ||
      (query.scope === "due" && item.review_count > 0 && item.sort_date > query.date)) return listFailure();
    const card = item as ReviewListCard;
    if (ids.has(card.id) || (previous && compareCards(card, previous) <= 0)) return listFailure();
    ids.add(card.id); previous = card;
  }
  if (value.nextCursor !== null) {
    const tail = decodeUpdatedAtCursor(value.nextCursor as string);
    if (!previous || value.items.length !== query.limit || tail.updatedAt !== previous.sort_date || tail.id !== previous.id) return listFailure();
  }
  return value as ReviewList;
}

/** 实际复习可使同一卡在后页重现；只接受学习次数增长且排序前进的更新。 */
export function appendReviewList(previous: ReviewList, page: ReviewList): ReviewList {
  if (previous.summary.date !== page.summary.date) return listFailure();
  const replacements = new Set<number>();
  const oldCards = new Map(previous.items.map(card => [card.id, card]));
  for (const card of page.items) {
    const old = oldCards.get(card.id);
    if (!old) continue;
    if (card.review_count <= old.review_count || compareCards(card, old) <= 0) return listFailure();
    replacements.add(card.id);
  }
  return { ...page, items: [...previous.items.filter(card => !replacements.has(card.id)), ...page.items] };
}
