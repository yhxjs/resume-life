import type { CursorPage } from "./cursor-pagination";
import { parseIdCursor } from "./cursor-pagination";
import type { ProjectSummaryHistoryItem } from "./project-summary-history";
import { isStoredProjectSummary } from "./summary";

export type ProjectSummaryHistoryPage = CursorPage<ProjectSummaryHistoryItem> & { projectId: number };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** 只读取存档协议，不用生成草稿的非空/篇幅限制清洗历史原文。 */
export function readProjectSummaryHistoryPage(value: unknown, query: { projectId: number; cursor?: string; limit: number }): ProjectSummaryHistoryPage {
  const fail = () => { throw new Error("总结历史响应不完整或项目/分页不符，请重新读取"); };
  if (!record(value) || value.projectId !== query.projectId || !Array.isArray(value.items) || value.items.length > query.limit ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string") ||
    (value.total !== undefined && (typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < 0))) return fail();
  let previousId = Infinity;
  if (query.cursor !== undefined) {
    try { previousId = parseIdCursor(new URLSearchParams({ cursor: query.cursor })) ?? Infinity; }
    catch { return fail(); }
  }
  for (const item of value.items) {
    if (!record(item) || !positiveId(item.id) || item.id >= previousId ||
      (item.source !== "ai" && item.source !== "repo" && item.source !== "manual") || typeof item.createdAt !== "string" ||
      !isStoredProjectSummary(item.summary) || !Object.hasOwn(item.summary, "overview") || !record(item.aiBaseline) ||
      !Object.values(item.aiBaseline).every(text => typeof text === "string")) return fail();
    previousId = item.id;
  }
  if (value.nextCursor !== null && (value.items.length !== query.limit || value.nextCursor !== String(previousId))) return fail();
  return value as ProjectSummaryHistoryPage;
}
