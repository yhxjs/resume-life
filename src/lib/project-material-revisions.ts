import { createHash } from "node:crypto";
import { dataGeneration } from "./db";
import { serializeDocumentTableProvenance, type DocumentTableProvenance } from "./document-table-provenance";

export type MaterialRevisionInput = { id: number; title: string; content: string; tableProvenance?: DocumentTableProvenance };

/** 材料版本绑定数据库世代和完整正文，恢复数据后旧标签页不能覆盖新材料。 */
export function materialRevision(projectId: number, material: MaterialRevisionInput): string {
  const hash = createHash("sha256").update(JSON.stringify([dataGeneration(), projectId, material.id, material.title, material.content]));
  // 无来源沿用旧摘要，避免旧材料凭空变更；来源本身改变也必须使旧编辑令牌失效。
  if (material.tableProvenance !== undefined) hash.update("\0docx-table-provenance-v1\0").update(serializeDocumentTableProvenance(material.tableProvenance, material.content));
  return hash.digest("hex");
}
