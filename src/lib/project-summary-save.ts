import { isStoredProjectSummary, type ProjectSummary } from "./summary";

export type ProjectSummarySaveConfirmation = { revisionId: number; summary: ProjectSummary; summary_updated_at?: string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function completeSummary(value: unknown): value is ProjectSummary {
  return isStoredProjectSummary(value) && Object.hasOwn(value, "overview");
}
function timestamp(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value)));
}

/** 与服务端落库前的规范化结果逐字段比较；回包不能通过清洗补齐残缺正文。 */
export function matchesProjectSummary(actual: ProjectSummary, expected: ProjectSummary): boolean {
  return (Object.keys(expected) as (keyof ProjectSummary)[]).every(key => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
}

export function readProjectSummarySaveConfirmation(value: unknown, expected: ProjectSummary, previousRevision: number): ProjectSummarySaveConfirmation {
  if (!record(value) || (value.ok !== undefined && value.ok !== true) ||
      typeof value.revisionId !== "number" || !Number.isSafeInteger(value.revisionId) || value.revisionId <= previousRevision ||
      !completeSummary(value.summary) || !matchesProjectSummary(value.summary, expected) || !timestamp(value.summary_updated_at)) {
    throw new Error("总结保存响应不完整或与本次提交不符");
  }
  return value as ProjectSummarySaveConfirmation;
}

/** 结果未知时读取实际档案；先校验身份和完整结构，才允许判断是否与本次提交一致。 */
export function readProjectSummarySavedDetail(value: unknown, projectId: string): ProjectSummarySaveConfirmation {
  if (!record(value) || String(value.id) !== projectId || typeof value.id !== "number" ||
      typeof value.summary_revision_id !== "number" || !Number.isSafeInteger(value.summary_revision_id) || value.summary_revision_id < 0 ||
      !completeSummary(value.summary) || (value.summary_revision_id > 0 && !timestamp(value.summary_updated_at))) {
    throw new Error("总结核对响应不完整或不属于当前项目");
  }
  return { revisionId: value.summary_revision_id, summary: value.summary,
    ...(typeof value.summary_updated_at === "string" ? { summary_updated_at: value.summary_updated_at } : {}) };
}
