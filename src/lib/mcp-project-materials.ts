import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readMcpRepositoryRoots } from "@/mcp/repository-config.mjs";
import { getDb, inTransaction } from "./db";
import { loadProjectRow } from "./projects";
import { iterateProjectMaterialSources, loadProjectMaterial, updateProjectMaterial } from "./project-materials";
import { assertProjectMaterial, assertProjectMaterialTitle } from "./request-limits";
import { validateRepoPaths } from "./repo-scanner/path-validator";
import { collectRepoSourceSnapshot } from "./repo-scanner/source-snapshot";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { mcpRevision } from "./mcp-revision";
import { mcpCreateOnce, mcpCreateWithResult, readMcpOperationResult } from "./mcp-state";
import { McpOperationError } from "./mcp-errors";
import { withMcpWorkLease } from "./mcp-work-leases";
import { upsertRepositoryEvidence } from "./repository-evidence-store";
import { observeMissingRepositoryFile } from "./repo-scanner/source-presence";
import { repoRootPathError } from "./repo-scanner/path-policy";

function capture(projectId: number, materialId?: number) {
  const project = loadProjectRow(projectId);
  if (!project) throw new McpOperationError("NOT_FOUND", "项目不存在");
  const material = materialId === undefined ? null : loadProjectMaterial(projectId, materialId);
  if (materialId !== undefined && !material) throw new McpOperationError("NOT_FOUND", "材料不存在或不属于该项目");
  return { workflow: "project-material", project, materials: Array.from(iterateProjectMaterialSources(projectId)), material,
    instructions: "filename 是可维护的来源定位说明，不触发文件访问，也不自动证明资料真实。编辑正文会清除旧 DOCX 结构来源；来源定位或正文改变均使总结预览失效。仓库证据通过已配置目录采集，再选择文件保存。" };
}
export function getProjectMaterialContext(projectId: number, materialId: number | undefined, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(projectId, materialId), page));
}
export type MaterialEdit = { projectId: number; materialId: number; expectedRevision: string; title?: string; content?: string; filename?: string };
function prepareEdit(input: MaterialEdit) {
  const context = capture(input.projectId, input.materialId); assertMcpContext(context, input.expectedRevision);
  const before = context.material!;
  const after = { title: input.title?.trim() ?? before.title, content: input.content ?? before.content, filename: input.filename ?? before.filename };
  if (!after.title || !after.content.trim()) throw new McpOperationError("INVALID_ARGUMENT", "材料标题和正文不能为空");
  assertProjectMaterialTitle(after.title); assertProjectMaterial(after.content);
  return { before, after, tableProvenanceCleared: before.content !== after.content && before.tableProvenance !== undefined,
    previewToken: mcpRevision("content-preview", ["project-material", mcpContextRevision(context), after]) };
}
export function previewProjectMaterialEdit(input: MaterialEdit, page: ContextPageInput) {
  return inTransaction(() => { const result = prepareEdit(input); return { ...mcpContextPage(result, page), previewToken: result.previewToken }; });
}
export function saveProjectMaterialEdit(input: MaterialEdit & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_project_material_edit", idempotencyKey, payload, () => {
    const prepared = prepareEdit(input);
    if (prepared.previewToken !== input.previewToken) throw new McpOperationError("CONFLICT", "材料预览已变化");
    const saved = updateProjectMaterial(input.projectId, input.materialId, { ...prepared.after, expectedRevision: prepared.before.revision });
    if (saved.status !== "ok") throw new McpOperationError("CONFLICT", "材料已变化");
    return { id: input.materialId };
  }, id => !!getDb().prepare("SELECT 1 FROM project_materials WHERE id=? AND project_id=?").get(id, input.projectId));
}

function repositoryCatalog() {
  let roots: string[];
  try { roots = readMcpRepositoryRoots(); }
  catch { throw new McpOperationError("CONFIGURATION", "RESUME_LIFE_MCP_REPO_ROOTS 必须是最多 32 个绝对仓库目录的 JSON 数组"); }
  const repositories = roots.map((root: string, index: number) => {
    let canonical: string;
    try { canonical = fs.realpathSync(root); } catch { throw new McpOperationError("CONFIGURATION", "配置的仓库目录不可访问"); }
    return { index, name: path.basename(canonical), path: canonical };
  });
  return { repositories, instructions: "只能按配置目录的 index 采集。未配置时请在客户端环境中设置 RESUME_LIFE_MCP_REPO_ROOTS。采集复用受限源码读取器，不执行仓库程序或调用模型；扫描有篇幅、文件类型与目录边界，未采集部分不能视为不存在。" };
}
export function getRepositoryCatalog(page: ContextPageInput) { return mcpContextPage(repositoryCatalog(), page); }
export type RepositoryCapture = { id: number; root: string; repositoryName: string; capturedAt: string; snapshot: string;
  baselineCaptureKey?: string; missingFiles?: { locator: string; status: "deleted" | "not-captured" }[];
  files: { index: number; locator: string; content: string; sha256: string; truncated: boolean }[] };
type CaptureInput = { projectId: number; repositoryIndex: number; expectedCatalogRevision: string; expectedProjectRevision: string; idempotencyKey: string; baselineCaptureKey?: string };
function prepareCapture(input: CaptureInput) {
  const catalog = repositoryCatalog(); assertMcpContext(catalog, input.expectedCatalogRevision);
  assertMcpContext(capture(input.projectId), input.expectedProjectRevision);
  const repository = catalog.repositories[input.repositoryIndex];
  if (!repository) throw new McpOperationError("INVALID_ARGUMENT", "所选仓库不在配置目录中");
  if (input.baselineCaptureKey) {
    const baseline = readCapture(input.baselineCaptureKey);
    if (baseline.id !== input.projectId || baseline.root !== repository.path) throw new McpOperationError("INVALID_ARGUMENT", "基准采集不属于同一项目和仓库");
  }
  const checked = validateRepoPaths([repository.path]);
  const stat = input.baselineCaptureKey ? fs.lstatSync(repository.path) : null;
  const knownRoot = !!input.baselineCaptureKey && !repoRootPathError(repository.path) && stat?.isDirectory() && !stat.isSymbolicLink();
  if ((!checked.valid || checked.paths[0]?.normalizedPath !== repository.path) && !knownRoot) throw new McpOperationError("INVALID_ARGUMENT", "配置目录不是可采集的项目仓库");
  return repository;
}
export async function captureProjectRepository(input: CaptureInput, signal: AbortSignal) {
  const replay = recoverRepositoryCapture(input.idempotencyKey);
  if (!replay) return withMcpWorkLease("capture", signal, activeSignal => captureRepository(input, activeSignal));
  return captureRepository(input, signal);
}
async function captureRepository(input: CaptureInput, signal: AbortSignal) {
  const { idempotencyKey, ...payload } = input;
  const replay = getDb().prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='capture_project_repository' AND request_key=?").get(idempotencyKey);
  let collected: RepositoryCapture | undefined;
  if (!replay) {
    const repository = inTransaction(() => prepareCapture(input));
    const snapshot = await collectRepoSourceSnapshot([{ path: repository.path }], signal);
    if (!snapshot.trim() && !input.baselineCaptureKey) throw new McpOperationError("INVALID_ARGUMENT", "仓库中没有可采集的非空源码或文档");
    const files: RepositoryCapture["files"] = [];
    for (const line of snapshot.split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { kind?: string; path?: string; content?: string; truncated?: boolean };
      if (row.kind === "file" && typeof row.path === "string" && typeof row.content === "string") files.push({ index: files.length,
        locator: `${repository.name}/${row.path}`, content: row.content, truncated: row.truncated === true, sha256: createHash("sha256").update(row.content).digest("hex") });
    }
    collected = { id: input.projectId, root: repository.path, repositoryName: repository.name, capturedAt: new Date().toISOString(), snapshot, files };
    if (input.baselineCaptureKey) {
      const baseline = readCapture(input.baselineCaptureKey), captured = new Set(files.map(file => file.locator));
      const missingFiles: NonNullable<RepositoryCapture["missingFiles"]> = [];
      for (const file of baseline.files) if (!captured.has(file.locator)) {
        signal.throwIfAborted();
        const relative = file.locator.slice(baseline.repositoryName.length + 1);
        missingFiles.push({ locator: file.locator, status: await observeMissingRepositoryFile(repository.path, relative) });
      }
      collected.baselineCaptureKey = input.baselineCaptureKey; collected.missingFiles = missingFiles;
    }
  }
  const result = mcpCreateWithResult("capture_project_repository", idempotencyKey, payload, () => {
    signal.throwIfAborted(); prepareCapture(input);
    if (!collected) throw new McpOperationError("CONFLICT", "采集状态变化，请重试");
    return collected;
  }, id => !!loadProjectRow(id));
  assertCaptureAllowed(result);
  return { id: result.id, fileCount: result.files.length, capturedAt: result.capturedAt, capture: { tool: "get_repository_capture" as const, idempotencyKey } };
}
function assertCaptureAllowed(result: RepositoryCapture) {
  if (!repositoryCatalog().repositories.some(repository => repository.path === result.root)) throw new McpOperationError("FORBIDDEN", "该仓库已不在当前允许目录中");
}
function readCapture(key: string) {
  const result = readMcpOperationResult("capture_project_repository", key) as RepositoryCapture;
  assertCaptureAllowed(result); return result;
}
export function getRepositoryCapture(key: string, page: ContextPageInput) { return inTransaction(() => mcpContextPage(readCapture(key), page)); }
export function recoverRepositoryCapture(key: string) {
  if (!getDb().prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='capture_project_repository' AND request_key=?").get(key)) return undefined;
  const result = readCapture(key);
  return { id: result.id, fileCount: result.files.length, capturedAt: result.capturedAt, capture: { tool: "get_repository_capture", idempotencyKey: key } };
}
export { readCapture as readRepositoryCapture, capture as captureProjectMaterialContext };
export function saveRepositoryEvidence(input: { projectId: number; captureKey: string; fileIndexes: number[]; expectedCaptureRevision: string; expectedProjectRevision: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  const result = mcpCreateWithResult("save_repository_evidence", idempotencyKey, payload, () => {
    const source = readCapture(input.captureKey); assertMcpContext(source, input.expectedCaptureRevision);
    assertMcpContext(capture(input.projectId), input.expectedProjectRevision);
    if (source.id !== input.projectId) throw new McpOperationError("INVALID_ARGUMENT", "采集记录不属于该项目");
    if (new Set(input.fileIndexes).size !== input.fileIndexes.length) throw new McpOperationError("INVALID_ARGUMENT", "文件索引不能重复");
    const baseline = source.baselineCaptureKey ? readCapture(source.baselineCaptureKey) : source;
    const materialIds = input.fileIndexes.map(index => {
      const file = source.files[index];
      if (!file) throw new McpOperationError("INVALID_ARGUMENT", "所选文件不存在");
      const baselineFile = baseline.files.find(previous => previous.locator === file.locator);
      return upsertRepositoryEvidence({ projectId: input.projectId, root: source.root, captureKey: input.captureKey, capturedAt: source.capturedAt, file,
        baseline: baselineFile ? { file: baselineFile, capturedAt: baseline.capturedAt, captureKey: source.baselineCaptureKey ?? input.captureKey } : undefined, allowReplace: false });
    });
    return { id: input.projectId, materialIds };
  }, id => !!loadProjectRow(id));
  return result;
}
