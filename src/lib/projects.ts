import { getDb, inTransaction, now } from "./db";
import { parseSummary, ProjectSummaryCorruptError } from "./summary";
import { ModelInputBudgetError } from "./llm-input-budget";
import { serializeProjectInterviewContext } from "./project-interview-context";
import { iterateProjectMaterialSources } from "./project-materials";
import { DocumentTableProvenanceError } from "./document-table-provenance";

export class ProjectNotFoundError extends Error {
  constructor() {
    super("项目不存在");
    this.name = "ProjectNotFoundError";
  }
}

export function createProjectRecord(name: string): number {
  const ts = now();
  return inTransaction(() => Number(getDb().prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
    .run(name, ts, ts).lastInsertRowid));
}

export function loadProjectRow(id: number, db = getDb()) {
  return db
    .prepare("SELECT id, name, summary, summary_updated_at, created_at, updated_at FROM projects WHERE id = ?")
    .get(id) as
    | { id: number; name: string; summary: string; summary_updated_at: string; created_at: string; updated_at: string }
    | undefined;
}

/** 完整项目档案与材料；超限即拒绝，不把截断片段交给出题或评分。 */
export async function loadProjectContext(projectId: number, opts?: { maxChars?: number }): Promise<string> {
  // 同步短事务读取同一份档案与材料，模型等待期间不持锁。
  return inTransaction(() => readProjectContext(projectId, opts));
}

/** 提交前复核实际提供的完整记录；忽略未进入提示词的时间戳等元数据。 */
export function projectContextMatches(projectId: number, expected: string): boolean {
  try {
    return inTransaction(() => readProjectContext(projectId, { maxChars: expected.length }) === expected);
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectSummaryCorruptError
      || error instanceof ModelInputBudgetError || error instanceof DocumentTableProvenanceError) return false;
    throw error;
  }
}

export function readProjectContext(projectId: number, opts?: { maxChars?: number }): string {
  const row = loadProjectRow(projectId);
  if (!row) throw new ProjectNotFoundError();
  return serializeProjectInterviewContext({
    projectName: row.name,
    archive: parseSummary(row.summary),
    materials: iterateProjectMaterialSources(projectId),
  }, opts?.maxChars ?? 40_000);
}
