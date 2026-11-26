import { getDb, inTransaction } from "./db";
import { loadProjectRow } from "./projects";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { captureProjectMaterialContext, readRepositoryCapture } from "./mcp-project-materials";
import { evidenceContent, evidenceMaterial, latestEvidence, upsertRepositoryEvidence, removeRepositoryEvidence, type EvidenceVersion } from "./repository-evidence-store";
import { mcpCreateWithResult } from "./mcp-state";
import { McpOperationError } from "./mcp-errors";
import { fitPage, pageParams, type PageInput } from "./mcp-read";

type DiffSource = { projectId: number; baseCaptureKey: string; nextCaptureKey: string };
type Edit = DiffSource & { expectedRevision: string; selections: { locator: string; action: "upsert" | "remove" }[] };
function diff(source: DiffSource) {
  const before = readRepositoryCapture(source.baseCaptureKey), after = readRepositoryCapture(source.nextCaptureKey);
  if (before.id !== source.projectId || after.id !== source.projectId || before.root !== after.root) throw new McpOperationError("INVALID_ARGUMENT", "两份采集必须属于同一项目和仓库");
  const project = captureProjectMaterialContext(source.projectId);
  const previous = new Map(before.files.map(file => [file.locator, file])), next = new Map(after.files.map(file => [file.locator, file]));
  const missing = new Map(after.baselineCaptureKey === source.baseCaptureKey ? after.missingFiles?.map(file => [file.locator, file.status]) : []);
  const changes = [...new Set([...previous.keys(), ...next.keys()])].sort().map(locator => {
    const old = previous.get(locator) ?? null, file = next.get(locator) ?? null;
    const kind = !old ? "added" : !file ? missing.get(locator) === "deleted" ? "deleted" : "not-captured"
      : old.sha256 === file.sha256 && old.truncated === file.truncated ? "unchanged" : "modified";
    const currentMaterial = evidenceMaterial(source.projectId, before.root, locator, old ? { file: old, capturedAt: before.capturedAt } : undefined);
    const latest = latestEvidence(source.projectId, before.root, locator);
    return { locator, kind, before: old, after: file, currentMaterial, latest: latest ?? null,
      materialEdited: !!currentMaterial && !!latest && currentMaterial.content !== JSON.parse(latest.material_snapshot).content };
  });
  return { workflow: "repository-evidence-update", source, before, after, project, changes,
    affectedSummary: { projectId: source.projectId, summary: project.project.summary, summaryUpdatedAt: project.project.summary_updated_at },
    instructions: "unchanged 仅说明已采集片段相同，截断文件的其他部分仍未知。not-captured 不能当作删除。更新或移除仅作用于明确选择的材料；保存历史保留原文。材料变更后已有总结提案需重新生成，正式总结保留并提示复核。" };
}
export function getRepositoryEvidenceDiff(source: DiffSource, page: ContextPageInput) { return inTransaction(() => mcpContextPage(diff(source), page)); }
function proposal(input: Edit) {
  const source = { projectId: input.projectId, baseCaptureKey: input.baseCaptureKey, nextCaptureKey: input.nextCaptureKey };
  const context = diff(source); assertMcpContext(context, input.expectedRevision);
  if (!input.selections.length || new Set(input.selections.map(row => row.locator)).size !== input.selections.length) throw new McpOperationError("INVALID_ARGUMENT", "必须选择不重复的文件");
  const edits = input.selections.map(selection => {
    const change = context.changes.find(row => row.locator === selection.locator);
    if (!change || (selection.action === "remove" ? change.kind !== "deleted" || !change.currentMaterial : !change.after)) throw new McpOperationError("INVALID_ARGUMENT", "所选更新不存在，或删除尚未得到采集确认");
    const material = change.currentMaterial, file = change.after, latest = change.latest;
    const unchanged = !!material && !!file && (latest ? latest.sha256 === file.sha256 && latest.truncated === Number(file.truncated) &&
      material.content === JSON.parse(latest.material_snapshot).content && material.filename === file.locator
      : change.before?.sha256 === file.sha256 && change.before.truncated === file.truncated);
    return { ...selection, before: material, after: selection.action === "remove" ? null : {
      title: material?.title ?? ("代码证据 · " + selection.locator).slice(0, 200), filename: selection.locator,
      content: unchanged ? material!.content : evidenceContent(file!, context.after.capturedAt) }, unchanged: selection.action === "upsert" && unchanged };
  });
  return { context, preview: { source, edits, affectedSummary: context.affectedSummary,
    summaryRequiresReview: edits.some(edit => !edit.unchanged), previewToken: mcpContextRevision({ source: input.expectedRevision, edits }) } };
}
export function previewRepositoryEvidenceUpdate(input: Edit, page: ContextPageInput) {
  return inTransaction(() => { const { preview } = proposal(input); return { ...mcpContextPage(preview, page), previewToken: preview.previewToken }; });
}
export function saveRepositoryEvidenceUpdate(input: Edit & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateWithResult("save_repository_evidence_update", idempotencyKey, payload, () => {
    const { context, preview } = proposal(input);
    if (input.previewToken !== preview.previewToken) throw new McpOperationError("CONFLICT", "证据更新提案已改变，请重新预览");
    const materialIds: number[] = [], removedMaterialIds: number[] = [];
    for (const selection of input.selections) {
      const change = context.changes.find(row => row.locator === selection.locator)!;
      const baseline = change.before ? { file: change.before, capturedAt: context.before.capturedAt, captureKey: input.baseCaptureKey } : undefined;
      const common = { projectId: input.projectId, root: context.after.root, captureKey: input.nextCaptureKey, capturedAt: context.after.capturedAt };
      if (selection.action === "upsert") materialIds.push(upsertRepositoryEvidence({ ...common, file: change.after!, baseline, allowReplace: true }));
      else removedMaterialIds.push(removeRepositoryEvidence({ ...common, baseline: baseline! }));
    }
    return { id: input.projectId, materialIds, removedMaterialIds, summaryRequiresReview: preview.summaryRequiresReview };
  }, id => !!loadProjectRow(id));
}
export function listRepositoryEvidenceHistory(projectId: number, input: PageInput) {
  if (!loadProjectRow(projectId)) throw new McpOperationError("NOT_FOUND", "项目不存在");
  const { limit, idCursor } = pageParams(input);
  const rows = getDb().prepare("SELECT id,material_id,locator,captured_at,change_kind,sha256,truncated,created_at FROM project_repository_evidence WHERE project_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?")
    .all(projectId, idCursor, idCursor, limit + 1) as Pick<EvidenceVersion, "id" | "material_id" | "locator" | "captured_at" | "change_kind" | "sha256" | "truncated" | "created_at">[];
  const more = rows.length > limit, items = rows.slice(0, limit).map(row => ({ ...row, truncated: row.truncated === 1,
    fullContent: { tool: "get_repository_evidence_version", projectId, id: row.id } }));
  return fitPage(items, more ? String(items.at(-1)!.id) : null, row => String(row.id));
}
export function getRepositoryEvidenceVersion(projectId: number, id: number, page: ContextPageInput) {
  return inTransaction(() => {
    const row = getDb().prepare("SELECT * FROM project_repository_evidence WHERE id=? AND project_id=?").get(id, projectId) as EvidenceVersion | undefined;
    if (!row) throw new McpOperationError("NOT_FOUND", "证据历史不存在");
    return mcpContextPage({ ...row, truncated: row.truncated === 1, material_snapshot: JSON.parse(row.material_snapshot),
      previous_material_snapshot: row.previous_material_snapshot ? JSON.parse(row.previous_material_snapshot) : null }, page);
  });
}
