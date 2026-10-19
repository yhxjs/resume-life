import { getDb, inTransaction, now } from "./db";
import { createCursorPage } from "./cursor-pagination";
import { materialRevision } from "./project-material-revisions";

export type ProjectMaterialMetadata = { id: number; title: string; source: string; filename: string; content_length: number; created_at: string };
export type ProjectMaterialDetail = Omit<ProjectMaterialMetadata, "content_length"> & { content: string; revision: string };

export function listProjectMaterials(projectId: number, cursor: number | null, limit: number) {
  const db = getDb();
  const rows = db.prepare("SELECT id, title, source, filename, length(content) AS content_length, created_at FROM project_materials WHERE project_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")
    .all(projectId, cursor, cursor, limit + 1) as ProjectMaterialMetadata[];
  const total = (db.prepare("SELECT COUNT(*) AS count FROM project_materials WHERE project_id = ?").get(projectId) as { count: number }).count;
  return { ...createCursorPage(rows, limit, (item) => String(item.id)), total };
}

export function loadProjectMaterial(projectId: number, materialId: number): ProjectMaterialDetail | null {
  const row = getDb().prepare("SELECT id, title, source, filename, content, created_at FROM project_materials WHERE id = ? AND project_id = ?")
    .get(materialId, projectId) as Omit<ProjectMaterialDetail, "revision"> | undefined;
  return row ? { ...row, revision: materialRevision(projectId, row) } : null;
}

export function updateProjectMaterial(projectId: number, materialId: number, input: { title: string; content: string; expectedRevision: string }) {
  return inTransaction(() => {
    const current = loadProjectMaterial(projectId, materialId);
    if (!current) return { status: "missing" as const };
    if (current.revision !== input.expectedRevision) return { status: "conflict" as const };
    const db = getDb();
    db.prepare("UPDATE project_materials SET title = ?, content = ? WHERE id = ? AND project_id = ?").run(input.title, input.content, materialId, projectId);
    db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now(), projectId);
    return { status: "ok" as const, revision: materialRevision(projectId, { id: materialId, ...input }) };
  });
}
