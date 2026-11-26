import { createHash } from "node:crypto";
import { getDb, now } from "./db";
import { createProjectMaterial, loadProjectMaterial, updateProjectMaterial } from "./project-materials";
import { McpOperationError } from "./mcp-errors";
import { assertProjectMaterial } from "./request-limits";

export type EvidenceFile = { locator: string; content: string; sha256: string; truncated: boolean };
export type EvidenceVersion = { id: number; project_id: number; material_id: number | null; repository_key: string; locator: string;
  capture_key: string; captured_at: string; change_kind: "added" | "modified" | "deleted"; sha256: string; truncated: number;
  content: string; material_snapshot: string; previous_material_snapshot: string | null; created_at: string };
export const repositoryKey = (root: string) => createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
export function evidenceContent(file: EvidenceFile, capturedAt: string) {
  return "仓库证据：" + file.locator + "\n采集时间：" + capturedAt + "\n片段 SHA-256：" + file.sha256 +
    "\n范围：" + (file.truncated ? "已截断，仅包含所采集片段" : "本次采集的文件正文") + "。该记录不能证明个人贡献或未采集部分。\n\n" + file.content;
}
export function latestEvidence(projectId: number, root: string, locator: string) {
  return getDb().prepare("SELECT * FROM project_repository_evidence WHERE project_id=? AND repository_key=? AND locator=? ORDER BY id DESC LIMIT 1")
    .get(projectId, repositoryKey(root), locator) as EvidenceVersion | undefined;
}
export function evidenceMaterial(projectId: number, root: string, locator: string, baseline?: { file: EvidenceFile; capturedAt: string }) {
  const latest = latestEvidence(projectId, root, locator);
  const tracked = latest?.material_id ? loadProjectMaterial(projectId, latest.material_id) : null;
  if (tracked || latest || !baseline) return tracked;
  // Match the exact known baseline from older releases, never a user-supplied label alone.
  const row = getDb().prepare("SELECT id FROM project_materials WHERE project_id=? AND filename=? AND content=? ORDER BY id LIMIT 1")
    .get(projectId, locator, evidenceContent(baseline.file, baseline.capturedAt)) as { id: number } | undefined;
  return row ? loadProjectMaterial(projectId, row.id) : null;
}
function recordVersion(projectId: number, root: string, captureKey: string, capturedAt: string, file: EvidenceFile,
  kind: EvidenceVersion["change_kind"], material: NonNullable<ReturnType<typeof loadProjectMaterial>>, deleted = false,
  previousMaterial?: ReturnType<typeof loadProjectMaterial>) {
  const snapshot = (row: NonNullable<ReturnType<typeof loadProjectMaterial>>) => JSON.stringify({ id: row.id, title: row.title, filename: row.filename, content: row.content });
  getDb().prepare("INSERT INTO project_repository_evidence(project_id,material_id,repository_key,locator,capture_key,captured_at,change_kind,sha256,truncated,content,material_snapshot,previous_material_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(projectId, deleted ? null : material.id, repositoryKey(root), file.locator, captureKey, capturedAt, kind, file.sha256, Number(file.truncated),
      file.content, snapshot(material), previousMaterial ? snapshot(previousMaterial) : null, now());
}
/** The caller owns the transaction containing the write and its MCP receipt. */
export function upsertRepositoryEvidence(input: { projectId: number; root: string; captureKey: string; capturedAt: string; file: EvidenceFile;
  baseline?: { file: EvidenceFile; capturedAt: string; captureKey: string }; allowReplace: boolean }) {
  const { projectId, root, captureKey, capturedAt, file } = input, previous = latestEvidence(projectId, root, file.locator);
  const material = evidenceMaterial(projectId, root, file.locator, input.baseline);
  const content = evidenceContent(file, capturedAt); assertProjectMaterial(content);
  if (material && previous?.sha256 === file.sha256 && previous.truncated === Number(file.truncated) &&
      material.content === JSON.parse(previous.material_snapshot).content && material.filename === file.locator) return material.id;
  if (material && !previous && input.baseline?.file.sha256 === file.sha256 && input.baseline.file.truncated === file.truncated) {
    recordVersion(projectId, root, input.baseline.captureKey, input.baseline.capturedAt, file, "added", material); return material.id;
  }
  if (material && !input.allowReplace) throw new McpOperationError("CONFLICT", "该文件已有不同或已编辑的证据，请使用增量差异预览后更新");
  let id: number;
  if (material) {
    if (!previous && input.baseline) recordVersion(projectId, root, input.baseline.captureKey, input.baseline.capturedAt, input.baseline.file, "added", material);
    const saved = updateProjectMaterial(projectId, material.id, { title: material.title, content, filename: file.locator, expectedRevision: material.revision });
    if (saved.status !== "ok") throw new McpOperationError("CONFLICT", "项目证据已变化");
    id = material.id;
  } else {
    id = createProjectMaterial(projectId, { title: ("代码证据 · " + file.locator).slice(0, 200), content, filename: file.locator, source: "file" })!;
  }
  recordVersion(projectId, root, captureKey, capturedAt, file, material ? "modified" : "added", loadProjectMaterial(projectId, id)!, false, material);
  return id;
}
export function removeRepositoryEvidence(input: { projectId: number; root: string; captureKey: string; capturedAt: string; baseline: { file: EvidenceFile; capturedAt: string; captureKey: string } }) {
  const { projectId, root, baseline, captureKey, capturedAt } = input;
  const material = evidenceMaterial(projectId, root, baseline.file.locator, baseline);
  if (!material) throw new McpOperationError("CONFLICT", "待移除的项目证据不存在");
  if (!latestEvidence(projectId, root, baseline.file.locator)) recordVersion(projectId, root, baseline.captureKey, baseline.capturedAt, baseline.file, "added", material);
  recordVersion(projectId, root, captureKey, capturedAt, baseline.file, "deleted", material, true);
  getDb().prepare("DELETE FROM project_materials WHERE id=? AND project_id=?").run(material.id, projectId);
  getDb().prepare("UPDATE projects SET updated_at=? WHERE id=?").run(now(), projectId);
  return material.id;
}
