import { getDb, inTransaction, now } from "./db";
import { createCursorPage } from "./cursor-pagination";
import { materialRevision } from "./project-material-revisions";
import { parseDocumentTableProvenance, serializeDocumentTableProvenance, type DocumentTableProvenance } from "./document-table-provenance";

export type ProjectMaterialMetadata = { id: number; title: string; source: string; filename: string; content_length: number; created_at: string };
export type ProjectMaterialDetail = Omit<ProjectMaterialMetadata, "content_length"> & { content: string; revision: string; tableProvenance?: DocumentTableProvenance };
export type ProjectMaterialSource = { id: number; title: string; content: string; tableProvenance?: DocumentTableProvenance };

/** 来源只能由文件提取器提供；HTTP JSON 创建和编辑入口不接收来源声明。 */
export function createProjectMaterial(projectId: number, input: {
  title: string; content: string; source: "paste" | "file"; filename: string; tableProvenance?: DocumentTableProvenance;
}): number | null {
  if (input.tableProvenance !== undefined && input.source !== "file") throw new Error("Only extracted files can carry table provenance");
  const provenance = input.tableProvenance === undefined ? null : serializeDocumentTableProvenance(input.tableProvenance, input.content);
  return inTransaction(() => {
    const db = getDb();
    if (!db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)) return null;
    const timestamp = now();
    const result = db.prepare("INSERT INTO project_materials (project_id, title, source, filename, content, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, input.title, input.source, input.filename, input.content, timestamp);
    const id = Number(result.lastInsertRowid);
    if (provenance !== null) db.prepare("INSERT INTO project_material_table_provenance (material_id, provenance) VALUES (?, ?)").run(id, provenance);
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
    return id;
  });
}

/** 同时读取正文和已验证来源；原文形似布局标签不能自行取得提取来源。 */
export function* iterateProjectMaterialSources(projectId: number, db = getDb()): IterableIterator<ProjectMaterialSource> {
  const rows = db.prepare("SELECT m.id, m.title, m.content, p.provenance FROM project_materials m LEFT JOIN project_material_table_provenance p ON p.material_id = m.id WHERE m.project_id = ? ORDER BY m.id")
    .iterate(projectId) as IterableIterator<{ id: number; title: string; content: string; provenance: string | null }>;
  for (const { provenance, ...row } of rows) {
    const tableProvenance = parseDocumentTableProvenance(provenance, row.content);
    yield { ...row, ...(tableProvenance === null ? {} : { tableProvenance }) };
  }
}

export function listProjectMaterials(projectId: number, cursor: number | null, limit: number) {
  const db = getDb();
  const rows = db.prepare("SELECT id, title, source, filename, length(content) AS content_length, created_at FROM project_materials WHERE project_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")
    .all(projectId, cursor, cursor, limit + 1) as ProjectMaterialMetadata[];
  const total = (db.prepare("SELECT COUNT(*) AS count FROM project_materials WHERE project_id = ?").get(projectId) as { count: number }).count;
  return { ...createCursorPage(rows, limit, (item) => String(item.id)), total };
}

export function loadProjectMaterial(projectId: number, materialId: number): ProjectMaterialDetail | null {
  const row = getDb().prepare("SELECT m.id, m.title, m.source, m.filename, m.content, m.created_at, p.provenance FROM project_materials m LEFT JOIN project_material_table_provenance p ON p.material_id = m.id WHERE m.id = ? AND m.project_id = ?")
    .get(materialId, projectId) as (Omit<ProjectMaterialDetail, "revision" | "tableProvenance"> & { provenance: string | null }) | undefined;
  if (!row) return null;
  const { provenance, ...material } = row;
  const tableProvenance = parseDocumentTableProvenance(provenance, material.content);
  const result = { ...material, ...(tableProvenance === null ? {} : { tableProvenance }) };
  return { ...result, revision: materialRevision(projectId, result) };
}

export function updateProjectMaterial(projectId: number, materialId: number, input: { title: string; content: string; expectedRevision: string }) {
  return inTransaction(() => {
    const current = loadProjectMaterial(projectId, materialId);
    if (!current) return { status: "missing" as const };
    if (current.revision !== input.expectedRevision) return { status: "conflict" as const };
    const db = getDb();
    db.prepare("UPDATE project_materials SET title = ?, content = ? WHERE id = ? AND project_id = ?").run(input.title, input.content, materialId, projectId);
    const tableProvenance = current.content === input.content ? current.tableProvenance : undefined;
    if (current.content !== input.content) db.prepare("DELETE FROM project_material_table_provenance WHERE material_id = ?").run(materialId);
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), projectId);
    return { status: "ok" as const, revision: materialRevision(projectId, { id: materialId, ...input, tableProvenance }) };
  });
}
