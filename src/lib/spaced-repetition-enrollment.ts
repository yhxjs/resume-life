import type { DatabaseSync } from "node:sqlite";
import { getReviewDate } from "./spaced-repetition";

/** 调用方与收藏操作共用事务；转接追练卡时保留既有排期和作答历史。 */
export function enrollNotebookReview(db: DatabaseSync, notebookId: number, timestamp = new Date().toISOString()): void {
  const entry = db.prepare("SELECT source, source_id FROM notebook_entries WHERE id=?").get(notebookId) as { source: string; source_id: number } | undefined;
  if (!entry) return;
  if (entry.source === "drill") {
    const moved = db.prepare("UPDATE review_cards SET notebook_id=?, drill_question_id=NULL WHERE drill_question_id=?").run(notebookId, entry.source_id);
    if (moved.changes) return;
  }
  db.prepare("INSERT OR IGNORE INTO review_cards (notebook_id, next_review_date, created_at) VALUES (?, ?, ?)")
    .run(notebookId, getReviewDate(new Date(timestamp)), timestamp);
}

/** 追练先在原练习完成一次作答；普通题目练习只有收藏后才进入复习。 */
export function enrollRemedialReview(db: DatabaseSync, questionId: number, timestamp = new Date().toISOString()): void {
  const question = db.prepare("SELECT q.id FROM drill_questions q JOIN drills d ON d.id=q.drill_id WHERE q.id=? AND d.source='interview' AND q.answered_at<>''").get(questionId);
  if (!question) return;
  const notebook = db.prepare("SELECT id FROM notebook_entries WHERE source='drill' AND source_id=?").get(questionId) as { id: number } | undefined;
  if (notebook) {
    enrollNotebookReview(db, notebook.id, timestamp);
    return;
  }
  db.prepare("INSERT OR IGNORE INTO review_cards (drill_question_id, next_review_date, created_at) VALUES (?, ?, ?)")
    .run(questionId, getReviewDate(new Date(timestamp)), timestamp);
}
