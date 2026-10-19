import { createHash } from "node:crypto";
import { dataGeneration } from "./db";

export type MaterialRevisionInput = { id: number; title: string; content: string };

/** 材料版本绑定数据库世代和完整正文，恢复数据后旧标签页不能覆盖新材料。 */
export function materialRevision(projectId: number, material: MaterialRevisionInput): string {
  return createHash("sha256")
    .update(JSON.stringify([dataGeneration(), projectId, material.id, material.title, material.content]))
    .digest("hex");
}
