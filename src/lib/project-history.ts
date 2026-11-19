import { readProjectMaterialImportPage } from "@/lib/project-material-import";
import { readProjectSummarySavedDetail } from "@/lib/project-summary-save";

export type ProjectListItem = { id: number; name: string; summary_updated_at: string; updated_at: string; material_count: number };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** 目录按完整响应校验，保留历史名称，不套用新建时的长度限制。 */
export function readProjectList(value: unknown): ProjectListItem[] {
  const invalid = () => new Error("项目列表响应不完整或存在重复记录，请重新加载");
  if (!Array.isArray(value)) throw invalid();
  const ids = new Set<number>();
  for (const row of value) {
    if (!record(row) || typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) ||
        !["name", "summary_updated_at", "updated_at"].every(key => typeof row[key] === "string") ||
        typeof row.material_count !== "number" || !Number.isSafeInteger(row.material_count) || row.material_count < 0) throw invalid();
    ids.add(row.id);
  }
  return value as ProjectListItem[];
}

/** 删除核对只读取真实档案，复用材料与总结协议，不清洗或保存历史正文。 */
export function validateExistingProject(value: unknown, id: number): void {
  readProjectMaterialImportPage(value, String(id));
  readProjectSummarySavedDetail(value, String(id));
  if (!record(value) || value.summary_corrupt !== false ||
      !["name", "summary_updated_at", "updated_at"].every(key => typeof value[key] === "string")) {
    throw new Error("项目详情响应不完整或不属于当前项目");
  }
}

export function projectDeletionTitle(item: ProjectListItem): string {
  return `${item.name}\n最后修改：${item.updated_at}；总结更新：${item.summary_updated_at || "尚未生成"}；${item.material_count} 份材料`;
}
