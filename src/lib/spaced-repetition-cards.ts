import { getDb, inTransaction, now } from "./db";
import { createCursorPage, encodeUpdatedAtCursor, type UpdatedAtCursor } from "./cursor-pagination";
import { getReviewDate, getReviewMastery, scheduleReview } from "./spaced-repetition";
import type { ReviewAttempt, ReviewCard, ReviewDetail, ReviewGrade, ReviewList, ReviewSource, ReviewSummary } from "./spaced-repetition-card-types";

const CARD_COLUMNS = `c.id, c.interval_days, c.ease_factor, c.repetitions, c.review_count, c.lapses,
  c.next_review_date, c.last_reviewed_at,
  CASE WHEN c.notebook_id IS NOT NULL THEN 'notebook' ELSE 'remedial' END AS source,
  COALESCE(c.notebook_id, c.drill_question_id) AS source_id,
  COALESCE(n.source_label, NULLIF(d.focus, ''), NULLIF(d.direction, ''), '面试追练') AS source_label,
  COALESCE(n.question, q.question) AS question`;
const CARD_FROM = `FROM review_cards c
  LEFT JOIN notebook_entries n ON n.id=c.notebook_id
  LEFT JOIN drill_questions q ON q.id=c.drill_question_id
  LEFT JOIN drills d ON d.id=q.drill_id`;
const ATTEMPT_COLUMNS = "id, answer, grade, reviewed_at, interval_days, next_review_date";

type CardRow = Omit<ReviewCard, "mastery">;
function cardWithMastery(row: CardRow, today?: string): ReviewCard {
  return { ...row, next_review_date: row.review_count === 0 && today ? today : row.next_review_date, mastery: getReviewMastery(row) };
}
function getReviewCard(id: number): ReviewCard | null {
  const row = getDb().prepare(`SELECT ${CARD_COLUMNS} ${CARD_FROM} WHERE c.id=?`).get(id) as CardRow | undefined;
  return row ? cardWithMastery(row) : null;
}

export function getReviewSummary(today: string): ReviewSummary {
  const summary = getDb().prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(review_count=0 OR next_review_date <= ?), 0) AS due,
    COALESCE(SUM((review_count=0 OR next_review_date <= ?) AND notebook_id IS NOT NULL), 0) AS notebook,
    COALESCE(SUM((review_count=0 OR next_review_date <= ?) AND drill_question_id IS NOT NULL), 0) AS remedial,
    COALESCE(SUM(review_count>0 AND next_review_date < ?), 0) AS overdue,
    (SELECT COUNT(DISTINCT card_id) FROM review_attempts WHERE review_date=?) AS completed_today
    FROM review_cards`).get(today, today, today, today, today) as Omit<ReviewSummary, "date">;
  return { date: today, ...summary };
}

export function listReviewCards(options: { today: string; scope: "due" | "all"; source: ReviewSource | "all"; limit: number; cursor: UpdatedAtCursor | null }): ReviewList {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (options.scope === "due") { conditions.push("(c.review_count=0 OR c.next_review_date <= ?)"); values.push(options.today); }
  if (options.source === "notebook") conditions.push("c.notebook_id IS NOT NULL");
  if (options.source === "remedial") conditions.push("c.drill_question_id IS NOT NULL");
  if (options.cursor) {
    conditions.push("(c.next_review_date > ? OR (c.next_review_date = ? AND c.id > ?))");
    values.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.id);
  }
  const rows = getDb().prepare(`SELECT ${CARD_COLUMNS} ${CARD_FROM}
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY c.next_review_date, c.id LIMIT ?`).all(...values, options.limit + 1) as CardRow[];
  const page = createCursorPage(rows, options.limit, row => encodeUpdatedAtCursor({ updatedAt: row.next_review_date, id: row.id }));
  // 游标使用存储日期；尚未学习的题目对任意时区都显示为今日可开始。
  return { items: page.items.map(row => cardWithMastery(row, options.today)), nextCursor: page.nextCursor, summary: getReviewSummary(options.today) };
}

export function getReviewDetail(id: number, limit: number, cursor: number | null, today = getReviewDate()): ReviewDetail | null {
  const db = getDb();
  const row = db.prepare(`SELECT ${CARD_COLUMNS}, COALESCE(n.answer, q.answer, '') AS answer,
    COALESCE(n.reference, q.reference, '') AS reference, COALESCE(n.comment, q.comment, '') AS comment
    ${CARD_FROM} WHERE c.id=?`).get(id) as (CardRow & { answer: string; reference: string; comment: string }) | undefined;
  if (!row) return null;
  const attempts = db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM review_attempts
    WHERE card_id=? ${cursor === null ? "" : "AND id < ?"} ORDER BY id DESC LIMIT ?`)
    .all(...(cursor === null ? [id, limit + 1] : [id, cursor, limit + 1])) as ReviewAttempt[];
  const page = createCursorPage(attempts, limit, attempt => String(attempt.id));
  return { ...row, ...cardWithMastery(row, today), attempts: page.items, nextCursor: page.nextCursor };
}

export class ReviewError extends Error {
  constructor(message: string, readonly status: 404 | 409) { super(message); }
}

export function saveReview(id: number, input: { answer: string; grade: ReviewGrade; expected_review_count: number; request_id: string; time_zone?: string }): { card: ReviewCard; attempt: ReviewAttempt } {
  return inTransaction(() => {
    const db = getDb();
    const card = getReviewCard(id);
    if (!card) throw new ReviewError("复习题目不存在，可能已被移除", 404);
    const existing = db.prepare(`SELECT ${ATTEMPT_COLUMNS}, card_id FROM review_attempts WHERE request_id=?`)
      .get(input.request_id) as (ReviewAttempt & { card_id: number }) | undefined;
    if (existing) {
      if (existing.card_id !== id || existing.answer !== input.answer || existing.grade !== input.grade) {
        throw new ReviewError("该提交编号已用于其他回答，请重新提交", 409);
      }
      return { card, attempt: { id: existing.id, answer: existing.answer, grade: existing.grade, reviewed_at: existing.reviewed_at, interval_days: existing.interval_days, next_review_date: existing.next_review_date } };
    }
    if (card.review_count !== input.expected_review_count) {
      throw new ReviewError("该题已在其他页面复习，请重新加载题目后再提交；当前回答可保留", 409);
    }
    const timestamp = now();
    const today = getReviewDate(new Date(timestamp), input.time_zone);
    const next = scheduleReview(card, input.grade, today, timestamp);
    db.prepare(`UPDATE review_cards SET interval_days=?, ease_factor=?, repetitions=?, review_count=?,
      lapses=?, next_review_date=?, last_reviewed_at=? WHERE id=?`)
      .run(next.interval_days, next.ease_factor, next.repetitions, next.review_count, next.lapses, next.next_review_date, next.last_reviewed_at, id);
    const result = db.prepare(`INSERT INTO review_attempts
      (card_id, request_id, answer, grade, reviewed_at, review_date, interval_days, next_review_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.request_id, input.answer, input.grade, timestamp, today, next.interval_days, next.next_review_date);
    return {
      card: { ...card, ...next, mastery: getReviewMastery(next) },
      attempt: { id: Number(result.lastInsertRowid), answer: input.answer, grade: input.grade, reviewed_at: timestamp, interval_days: next.interval_days, next_review_date: next.next_review_date },
    };
  });
}
