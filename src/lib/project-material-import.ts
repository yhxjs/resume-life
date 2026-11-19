import type { ProjectMaterialMetadata } from "./project-materials";

export type ProjectMaterialImportExpected = { title: string; source: "paste" | "file"; filename: string };
export type ProjectMaterialImportPage = { materials: ProjectMaterialMetadata[]; total: number; nextCursor: string | null };
export type ProjectMaterialImportRecovery = {
  phase: "checking" | "unknown" | "confirming" | "idle";
  message: string;
  page: ProjectMaterialImportPage | null;
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** 与实际提交的来源、标题和文件名一致才接受确认，不用旧列表猜测写入归属。 */
export function readProjectMaterialImportConfirmation(value: unknown, expected: ProjectMaterialImportExpected): number {
  if (!record(value) || !positiveId(value.id) || (value.ok !== undefined && value.ok !== true) ||
      value.title !== expected.title || value.source !== expected.source || value.filename !== expected.filename) {
    throw new Error("材料导入响应不完整或与本次提交不符");
  }
  return value.id;
}

/** 只验证供人工核对的最近一页；同名、同文及空页均不能证明本次请求已结束。 */
export function readProjectMaterialImportPage(value: unknown, projectId: string): ProjectMaterialImportPage {
  const invalid = () => new Error("材料列表核对响应不完整或不属于当前项目");
  if (!record(value) || !positiveId(value.id) || String(value.id) !== projectId ||
      !Array.isArray(value.materials) || value.materials.length > 50 ||
      typeof value.materials_total !== "number" || !Number.isSafeInteger(value.materials_total) || value.materials_total < value.materials.length ||
      !(value.materials_next_cursor === null || typeof value.materials_next_cursor === "string")) throw invalid();
  let previousId = Infinity;
  for (const material of value.materials) {
    if (!record(material) || !positiveId(material.id) || material.id >= previousId ||
        !["title", "source", "filename", "created_at"].every(key => typeof material[key] === "string") ||
        typeof material.content_length !== "number" || !Number.isSafeInteger(material.content_length) || material.content_length < 0) throw invalid();
    previousId = material.id;
  }
  if (value.materials_next_cursor !== null && (value.materials.length === 0 || value.materials_next_cursor !== String(previousId))) throw invalid();
  return { materials: value.materials as ProjectMaterialMetadata[], total: value.materials_total, nextCursor: value.materials_next_cursor };
}
