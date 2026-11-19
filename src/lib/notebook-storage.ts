import { getDb } from "@/lib/db";
import { getNotebookReviewLink } from "@/lib/spaced-repetition-cards";
import type { NotebookFavorite, NotebookFavoriteSource } from "@/lib/notebook-records";

/** 精确读取来源身份对应的独立收藏；来源已删除时仍保留快照，不创建或修复复习卡。 */
export function loadNotebookFavorite(source: NotebookFavoriteSource, sourceId: number): NotebookFavorite | undefined {
  const saved = getDb().prepare(`SELECT id, source, source_id, category_id, question, answer, comment, reference
    FROM notebook_entries WHERE source = ? AND source_id = ?`).get(source, sourceId) as Omit<NotebookFavorite, "review"> | undefined;
  return saved ? { ...saved, review: getNotebookReviewLink(saved.id) } : undefined;
}
