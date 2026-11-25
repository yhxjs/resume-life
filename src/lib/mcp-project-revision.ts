import { createHash } from "node:crypto";
import { getDb } from "./db";
import { mcpRevision } from "./mcp-revision";
import type { loadProjectRow } from "./projects";

/** Compute in the same transaction as the project row; never hash bounded previews. */
export function mcpProjectRevision(project: NonNullable<ReturnType<typeof loadProjectRow>>, database = getDb()): string {
  const hash = createHash("sha256").update(mcpRevision("project-target", project));
  const materials = database.prepare(`SELECT m.id, m.title, m.source, m.filename, m.content, m.created_at, p.provenance
    FROM project_materials m LEFT JOIN project_material_table_provenance p ON p.material_id = m.id
    WHERE m.project_id = ? ORDER BY m.id`).iterate(project.id);
  for (const material of materials) hash.update("\n").update(JSON.stringify(material));
  return hash.digest("hex");
}
