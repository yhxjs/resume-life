import type { ProjectMaterialDetail } from "./project-materials";

export type ProjectMaterialSaveRecovery = { checking: boolean; retry: boolean; message: string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function readProjectMaterialSaveConfirmation(value: unknown): string {
  if (!record(value) || value.ok !== true || !revision(value.revision)) throw new Error("材料保存响应不完整");
  return value.revision;
}

/** 核对完整存档，不清洗原文；材料 ID 在数据库中唯一，须与当前请求一致。 */
export function readProjectMaterialSavedDetail(value: unknown, materialId: number): ProjectMaterialDetail {
  if (!record(value) || value.id !== materialId || !revision(value.revision) ||
      !["title", "content", "source", "filename", "created_at"].every(key => typeof value[key] === "string")) {
    throw new Error("材料核对响应不完整或不属于当前材料");
  }
  return value as ProjectMaterialDetail;
}
