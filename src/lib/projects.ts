import { getDb } from "./db";
import { collectByCharacterBudget } from "./budgeted-query";
import { parseSummary, SUMMARY_SECTIONS } from "./summary";

export class ProjectNotFoundError extends Error {
  constructor() {
    super("项目不存在");
    this.name = "ProjectNotFoundError";
  }
}

export function loadProjectRow(id: number) {
  const db = getDb();
  return db
    .prepare("SELECT id, name, summary, summary_updated_at, created_at, updated_at FROM projects WHERE id = ?")
    .get(id) as
    | { id: number; name: string; summary: string; summary_updated_at: string; created_at: string; updated_at: string }
    | undefined;
}

export async function collectProjectMaterialText(
  projectId: number,
  maxChars: number,
  format: (material: { id: number; title: string; content: string }, index: number) => string,
): Promise<string> {
  const db = getDb();
  let index = 0;
  const chunks = await collectByCharacterBudget({
    maxChars,
    batchSize: 50,
    loadAfter: (cursor, limit) => db
      .prepare(
        "SELECT id, title, content FROM project_materials WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?",
      )
      .all(projectId, cursor, limit) as { id: number; title: string; content: string }[],
    cursorOf: (material) => material.id,
    format: (material) => format(material, index++),
  });
  return chunks.join("");
}

/** 把项目档案（总结条目 + 材料节选）拼成供 LLM 使用的上下文文本 */
export async function loadProjectContext(projectId: number, opts?: { maxChars?: number }): Promise<string> {
  const row = loadProjectRow(projectId);
  if (!row) throw new ProjectNotFoundError();
  const maxChars = opts?.maxChars ?? 40000;
  const parts: string[] = [`项目名称：${row.name}`];
  const summary = parseSummary(row.summary);
  const summaryLines = SUMMARY_SECTIONS.filter((s) => summary[s.key].trim()).map(
    (s) => `【${s.label}】${summary[s.key].trim()}`
  );
  if (summaryLines.length) parts.push("项目档案：\n" + summaryLines.join("\n"));
  const fixedContext = parts.join("\n\n");
  if (fixedContext.length >= maxChars) return fixedContext.slice(0, maxChars);

  const materials = await collectProjectMaterialText(
    projectId,
    maxChars - fixedContext.length,
    (material, index) =>
      `${index === 0 ? "\n\n材料节选：\n" : "\n\n"}--- ${material.title} ---\n${material.content}`,
  );
  return fixedContext + materials;
}
