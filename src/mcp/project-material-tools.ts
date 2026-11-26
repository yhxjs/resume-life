import * as z from "zod/v4";
import { getProjectMaterialContext, previewProjectMaterialEdit, saveProjectMaterialEdit, getRepositoryCatalog, captureProjectRepository, getRepositoryCapture, saveRepositoryEvidence } from "@/lib/mcp-project-materials";
import { contextPageInput } from "./content-tools";
import { edit, id, json, key, read, revision, write } from "./records";
import { requireReads } from "./source-access";
import type { McpTools } from "./tools";
import { getRepositoryEvidenceDiff, previewRepositoryEvidenceUpdate, saveRepositoryEvidenceUpdate, listRepositoryEvidenceHistory, getRepositoryEvidenceVersion } from "@/lib/mcp-repository-update";

export function registerProjectMaterialTools(tools: McpTools) {
  const evidenceReads = () => requireReads(tools, "get_project", "list_project_materials", "get_project_material_context");
  const diffReads = () => { evidenceReads(); requireReads(tools, "get_repository_capture", "get_repository_catalog", "get_repository_evidence_diff"); };
  const source = { projectId: id, baseCaptureKey: key, nextCaptureKey: key };
  const update = { ...source, expectedRevision: revision, selections: z.array(z.strictObject({ locator: z.string().min(1).max(4096), action: z.enum(["upsert", "remove"]) })).min(1).max(20) };
  tools.register("get_repository_evidence_diff", { title: "对比两次仓库采集", description: "读取新增、修改、确认删除和未采集文件及当前证据材料。确认删除需要后一采集使用前一采集的 baselineCaptureKey。", annotations: read,
    inputSchema: z.strictObject({ ...source, ...contextPageInput }) }, async ({ offset, length, expectedRevision, ...input }) => { diffReads(); return json(getRepositoryEvidenceDiff(input, { offset, length, expectedRevision })); });
  tools.register("preview_repository_evidence_update", { title: "预览所选仓库证据更新", description: "完整展示所选材料修改前后和受影响总结。未采集文件不能移除，历史原文会保留。", annotations: read,
    inputSchema: z.strictObject({ ...update, page: z.strictObject(contextPageInput).optional() }) }, async ({ page = {}, ...input }) => { diffReads(); return json(previewRepositoryEvidenceUpdate(input, page)); });
  tools.register("save_repository_evidence_update", { title: "保存已预览的仓库证据更新", description: "原子更新所选材料和正式历史；同样内容不新增材料，旧总结提案失效，正式总结保留供复核。", annotations: edit,
    inputSchema: z.strictObject({ ...update, previewToken: revision, idempotencyKey: key }) }, async input => { diffReads(); requireReads(tools, "preview_repository_evidence_update"); return json(saveRepositoryEvidenceUpdate(input)); });
  tools.register("list_repository_evidence_history", { title: "列出正式仓库证据历史", description: "分页读取项目证据历史，缓存过期或仓库移出允许目录后仍可读取已保存的正式证据。", annotations: read,
    inputSchema: z.strictObject({ projectId: id, limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(200).optional() }) }, async ({ projectId, ...page }) => { evidenceReads(); return json(listRepositoryEvidenceHistory(projectId, page)); });
  tools.register("get_repository_evidence_version", { title: "读取历史证据原文", description: "完整读取指定版本的源码片段、采集定位及当时的项目材料快照。正式历史随项目备份恢复。", annotations: read,
    inputSchema: z.strictObject({ projectId: id, id, ...contextPageInput }) }, async ({ projectId, id: versionId, ...page }) => { evidenceReads(); return json(getRepositoryEvidenceVersion(projectId, versionId, page)); });
  const materialReads = () => requireReads(tools, "get_project", "list_project_materials", "get_project_material_context");
  tools.register("get_project_material_context", { title: "读取材料维护上下文", description: "完整读取项目材料及来源定位。编辑单份材料时传 materialId；采集或保存仓库证据时省略。", inputSchema: z.strictObject({ projectId: id, materialId: id.optional(), ...contextPageInput }), annotations: read }, async ({ projectId, materialId, ...page }) => {
    materialReads(); return json(getProjectMaterialContext(projectId, materialId, page));
  });
  const proposal = { projectId: id, materialId: id, expectedRevision: revision, title: z.string().trim().min(1).max(200).optional(), content: z.string().min(1).max(100_000).optional(), filename: z.string().max(1000).optional() };
  tools.register("preview_project_material_edit", { title: "预览材料和来源修改", description: "支持修改标题、完整正文及 filename 来源定位。定位是记录元数据，不读取指定路径。正文变化会清除旧表格结构来源。", inputSchema: z.strictObject({ ...proposal, page: z.strictObject(contextPageInput).optional() }), annotations: read }, async ({ page = {}, ...input }) => {
    materialReads(); return json(previewProjectMaterialEdit(input, page));
  });
  tools.register("save_project_material_edit", { title: "保存已预览材料修改", description: "按来源及预览令牌保存材料；网页读取一致，旧总结预览失效。", inputSchema: z.strictObject({ ...proposal, previewToken: revision, idempotencyKey: key }), annotations: edit }, async input => {
    materialReads(); requireReads(tools, "preview_project_material_edit"); return json(saveProjectMaterialEdit(input));
  });
  tools.register("get_repository_catalog", { title: "列出允许采集的仓库", description: "读取 RESUME_LIFE_MCP_REPO_ROOTS 配置目录及 revision；采集只能选择返回的索引。未配置时返回空列表。", inputSchema: z.strictObject(contextPageInput), annotations: read }, async input => json(getRepositoryCatalog(input)));
  tools.register("capture_project_repository", { title: "采集项目仓库证据", description: "按配置索引采集受限源码快照并持久保存；不运行 CLI 或模型。返回采集回执，用 get_repository_capture 完整读取范围和片段。", inputSchema: z.strictObject({ projectId: id, repositoryIndex: z.number().int().min(0).max(31), baselineCaptureKey: key.optional(), expectedCatalogRevision: revision, expectedProjectRevision: revision, idempotencyKey: key }), annotations: write }, async (input, ctx) => {
    materialReads(); requireReads(tools, "get_repository_catalog"); if (input.baselineCaptureKey) requireReads(tools, "get_repository_capture"); return json(await captureProjectRepository(input, ctx.mcpReq.signal));
  });
  tools.register("get_repository_capture", { title: "读取仓库采集快照", description: "用幂等键完整分页读取保存的源码、文件定位、摘要及截断范围；重连后读取同一份快照。移出允许目录后禁止读取。", inputSchema: z.strictObject({ idempotencyKey: key, ...contextPageInput }), annotations: read }, async ({ idempotencyKey, ...page }) => {
    materialReads(); requireReads(tools, "get_repository_catalog"); return json(getRepositoryCapture(idempotencyKey, page));
  });
  tools.register("save_repository_evidence", { title: "将仓库证据保存为项目材料", description: "选择采集快照中的 fileIndexes，保存带定位、采集时间和 SHA-256 的原文片段。要求采集及当前项目修订，保留截断说明。", inputSchema: z.strictObject({ projectId: id, captureKey: key, fileIndexes: z.array(z.number().int().min(0).max(10_000)).min(1).max(20), expectedCaptureRevision: revision, expectedProjectRevision: revision, idempotencyKey: key }), annotations: write }, async input => {
    materialReads(); requireReads(tools, "get_repository_capture", "get_repository_catalog"); return json(saveRepositoryEvidence(input));
  });
}
