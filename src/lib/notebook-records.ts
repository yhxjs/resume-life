import { readStoredScores, type ScoreMap } from "./scores";
import { REVIEW_MASTERY_LABELS, type ReviewLink, type ReviewMastery } from "./spaced-repetition-card-types";
import { matchesSqliteLikeSubstring } from "./sqlite-like";

export type NotebookEntry = {
  id: number;
  category_id: number | null;
  category_name: string | null;
  source: "drill" | "interview" | "application_interview";
  source_label: string;
  question: string;
  answer: string;
  comment: string;
  reference: string;
  scores: ScoreMap | null;
  created_at: string;
  updated_at: string;
  review_card_id: number | null;
  review_mastery: ReviewMastery | null;
  next_review_date: string | null;
};
export type NotebookCategory = { id: number; name: string; entry_count: number };
export type NotebookFavoriteSource = "drill" | "interview";
export type NotebookFavorite = { id: number; source: NotebookFavoriteSource; source_id: number; category_id: number | null; question: string; answer: string; comment: string; reference: string; review: ReviewLink | null };
export type NotebookCategoryFilter = "all" | number;
type NotebookListFilter = { category?: NotebookCategoryFilter; source?: NotebookEntry["source"] | ""; keyword?: string; cursor?: string };
export type NotebookListPage = { items: NotebookEntry[]; nextCursor: string | null };
export type NotebookDeletionTarget = Pick<NotebookEntry, "id" | "question" | "source"> &
  Partial<Pick<NotebookEntry, "source_label" | "category_name">>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isReviewLink(value: unknown): value is ReviewLink {
  return record(value) && positiveId(value.review_card_id) && typeof value.review_mastery === "string" &&
    Object.hasOwn(REVIEW_MASTERY_LABELS, value.review_mastery) && typeof value.next_review_date === "string";
}

/** 新写入必须带完整复习关联，不能用坏回包关闭收藏弹窗。 */
export function readCreatedNotebookFavorite(value: unknown): { id: number; review: ReviewLink } {
  if (!record(value) || !positiveId(value.id) || !isReviewLink(value.review)) throw new Error("收藏响应不完整");
  return { id: value.id, review: value.review };
}

/** 按来源身份核对独立快照，不用同文题目或新生成限制认领旧收藏。 */
export function readNotebookFavorite(value: unknown, source: NotebookFavoriteSource, sourceId: number): NotebookFavorite {
  if (!record(value) || value.source !== source || value.source_id !== sourceId || !positiveId(value.source_id)) throw new Error("收藏读取响应与来源不符");
  validateExistingNotebookEntry(value, value.id as number);
  if ((value.category_id !== null && !positiveId(value.category_id)) || (value.review !== null && !isReviewLink(value.review))) throw new Error("收藏读取响应不完整");
  return value as NotebookFavorite;
}

function isNotebookEntry(value: unknown): value is NotebookEntry {
  if (!record(value) || !positiveId(value.id) ||
    !["source_label", "question", "answer", "comment", "reference", "created_at", "updated_at"].every(key => typeof value[key] === "string") ||
    (value.source !== "drill" && value.source !== "interview" && value.source !== "application_interview")) return false;
  if (value.category_id === null ? value.category_name !== null : !positiveId(value.category_id) || typeof value.category_name !== "string") return false;
  if (value.scores !== null && !readStoredScores(value.scores)) return false;
  if (value.review_card_id === null) return value.review_mastery === null && value.next_review_date === null;
  return positiveId(value.review_card_id) && typeof value.review_mastery === "string" &&
    Object.hasOwn(REVIEW_MASTERY_LABELS, value.review_mastery) && typeof value.next_review_date === "string";
}

/** 只校验目录实际返回的协议，不改写历史原文或用新生成限制裁剪快照。 */
export function readNotebookListPage(value: unknown, { category = "all", source = "", keyword = "", cursor }: NotebookListFilter = {}): NotebookListPage {
  const fail = () => { throw new Error("错题读取响应不完整或筛选不符，请重新读取"); };
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 50 ||
    (value.nextCursor !== null && (typeof value.nextCursor !== "string" || !value.nextCursor))) return fail();
  let previousId = cursor === undefined ? Infinity : Number(cursor);
  if (cursor !== undefined && (!positiveId(previousId) || String(previousId) !== cursor)) return fail();
  const expectedKeyword = keyword.trim();
  for (const item of value.items) {
    if (!isNotebookEntry(item) || item.id >= previousId || (source !== "" && item.source !== source) ||
      (category !== "all" && item.category_id !== (category === 0 ? null : category)) ||
      (expectedKeyword && ![item.question, item.answer, item.comment].some(text => matchesSqliteLikeSubstring(text, expectedKeyword)))) return fail();
    previousId = item.id;
  }
  if (value.nextCursor !== null && (value.items.length === 0 || value.nextCursor !== String(value.items.at(-1).id))) return fail();
  return value as NotebookListPage;
}

/** 详情读取只核对同一收藏快照，保留历史长文本、空字段及原始字面量。 */
export function validateExistingNotebookEntry(value: unknown, id: number): void {
  if (record(value) && positiveId(value.id) && value.id === id &&
    ["question", "answer", "comment", "reference"].every(key => typeof value[key] === "string")) return;
  throw new Error("读取响应不完整或记录不符");
}

export function notebookDeletionTitle(entry: NotebookDeletionTarget): string {
  const source = { drill: "题目练习", interview: "模拟面试", application_interview: "真实面试" }[entry.source];
  const category = entry.category_name === undefined ? "" : `；分类：${entry.category_name ?? "未分类"}`;
  return `${entry.question}；来源：${source}${entry.source_label ? ` · ${entry.source_label}` : ""}${category}`;
}

export function readNotebookCategories(value: unknown): NotebookCategory[] {
  if (!Array.isArray(value)) throw new Error("分类响应不完整，请重试加载");
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const category of value) {
    if (!record(category) || !positiveId(category.id) || ids.has(category.id) || typeof category.name !== "string" ||
      names.has(category.name) || !Number.isSafeInteger(category.entry_count) || (category.entry_count as number) < 0) throw new Error("分类响应不完整，请重试加载");
    ids.add(category.id); names.add(category.name);
  }
  return value as NotebookCategory[];
}

export function readNotebookCategory(value: unknown, id: number): NotebookCategory {
  const category = readNotebookCategories([value])[0]!;
  if (category.id !== id) throw new Error("分类读取响应与记录不符");
  return category;
}

export function readCreatedNotebookCategory(value: unknown, name: string): Pick<NotebookCategory, "id" | "name"> {
  if (!record(value) || !positiveId(value.id) || value.name !== name) throw new Error("分类创建响应不完整或名称不符");
  return { id: value.id, name };
}

export function readNotebookCategoryAssignment(value: unknown, id: number): number | null {
  validateExistingNotebookEntry(value, id);
  if (!record(value) || (value.category_id !== null && !positiveId(value.category_id))) throw new Error("分类读取响应不完整");
  return value.category_id as number | null;
}
