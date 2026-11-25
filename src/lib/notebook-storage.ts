import { getDb, inTransaction, now } from "@/lib/db";
import { getNotebookReviewLink } from "@/lib/spaced-repetition-cards";
import type { NotebookFavorite, NotebookFavoriteSource } from "@/lib/notebook-records";
import { enrollNotebookReview } from "./spaced-repetition-enrollment";
import { linkNotebookToApplications } from "./application-preparation";
import { ApplicationInputError } from "./applications";
import { mcpRevision } from "./mcp-revision";

export class NotebookMutationError extends Error {
  constructor(message: string, readonly status: 404 | 409) { super(message); }
}

/** 收藏与复习关联共用事务；Web 与 MCP 复制同一份完整来源快照。 */
export function createNotebookFavorite(input: { source: unknown; sourceId: unknown; categoryId?: unknown }, acceptExisting = false) {
  const { source, sourceId } = input;
  if ((source !== "drill" && source !== "interview") || typeof sourceId !== "number" || !Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new ApplicationInputError("无效的收藏请求");
  }
  const categoryId = input.categoryId ?? null;
  if (categoryId !== null && (typeof categoryId !== "number" || !Number.isSafeInteger(categoryId) || categoryId <= 0)) throw new ApplicationInputError("无效的分类");
  return inTransaction(() => {
    const db = getDb();
    if (categoryId !== null && !db.prepare("SELECT 1 FROM notebook_categories WHERE id=?").get(categoryId)) throw new ApplicationInputError("分类不存在");
    const existing = loadNotebookFavorite(source, sourceId);
    if (existing) {
      if (!acceptExisting || (input.categoryId !== undefined && existing.category_id !== categoryId)) throw new NotebookMutationError("该题已在错题本中", 409);
      return { id: existing.id, review: existing.review };
    }
    const snapshot = db.prepare(source === "drill" ? `SELECT q.question,q.answer,q.comment,q.reference,q.scores,
      COALESCE(p.name,NULLIF(d.direction,''),substr(d.jd,1,30),'') AS source_label
      FROM drill_questions q JOIN drills d ON d.id=q.drill_id LEFT JOIN projects p ON p.id=d.project_id WHERE q.id=?`
      : `SELECT t.question,t.answer,t.comment,t.reference,t.scores,r.title AS source_label
      FROM interview_turns t JOIN interviews i ON i.id=t.interview_id JOIN resumes r ON r.id=i.resume_id WHERE t.id=?`)
      .get(sourceId) as { question: string; answer: string; comment: string; reference: string; scores: string; source_label: string | null } | undefined;
    if (!snapshot) throw new NotebookMutationError("原题目不存在，可能已被删除", 404);
    const timestamp = now();
    const result = db.prepare(`INSERT INTO notebook_entries
      (category_id,source,source_id,source_label,question,answer,comment,reference,scores,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(categoryId, source, sourceId, snapshot.source_label ?? "", snapshot.question, snapshot.answer, snapshot.comment, snapshot.reference, snapshot.scores, timestamp, timestamp);
    const id = Number(result.lastInsertRowid);
    enrollNotebookReview(db, id, timestamp);
    if (source === "interview") linkNotebookToApplications(id, sourceId);
    const review = getNotebookReviewLink(id);
    if (!review) throw new Error("收藏复习卡创建失败");
    return { id, review };
  });
}

export function getNotebookNote(notebookId: number) {
  if (!getDb().prepare("SELECT 1 FROM notebook_entries WHERE id=?").get(notebookId)) throw new NotebookMutationError("错题不存在或已删除", 404);
  const note = getDb().prepare("SELECT id,notebook_id,content,created_at,updated_at FROM notebook_notes WHERE notebook_id=?").get(notebookId) as
    { id: number; notebook_id: number; content: string; created_at: string; updated_at: string } | undefined;
  return { note: note ?? null, revision: mcpRevision("notebook-note", { notebookId, note: note ?? null }) };
}

/** 用户补充笔记不改写题目、原答或反馈快照；保存与冲突检测在同一事务。 */
export function saveNotebookNote(notebookId: number, input: { content: string; expectedRevision: string }) {
  if (typeof input.content !== "string" || input.content.length > 20_000 || input.content.includes("\u0000")) throw new ApplicationInputError("补充笔记须为 0–20000 字且不能包含空字符");
  return inTransaction(() => {
    const previous = getNotebookNote(notebookId);
    if (previous.revision !== input.expectedRevision) throw new NotebookMutationError("补充笔记已更新，请重新读取后提交", 409);
    const timestamp = now();
    getDb().prepare(`INSERT INTO notebook_notes (notebook_id,content,created_at,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(notebook_id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at`)
      .run(notebookId, input.content, timestamp, timestamp);
    return getNotebookNote(notebookId);
  });
}

/** 精确读取来源身份对应的独立收藏；来源已删除时仍保留快照，不创建或修复复习卡。 */
export function loadNotebookFavorite(source: NotebookFavoriteSource, sourceId: number): NotebookFavorite | undefined {
  const saved = getDb().prepare(`SELECT id, source, source_id, category_id, question, answer, comment, reference
    FROM notebook_entries WHERE source = ? AND source_id = ?`).get(source, sourceId) as Omit<NotebookFavorite, "review"> | undefined;
  return saved ? { ...saved, review: getNotebookReviewLink(saved.id) } : undefined;
}
