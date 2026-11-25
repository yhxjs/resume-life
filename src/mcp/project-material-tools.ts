import * as z from "zod/v4";
import { getProjectMaterialContext, previewProjectMaterialEdit, saveProjectMaterialEdit, getRepositoryCatalog, captureProjectRepository, getRepositoryCapture, saveRepositoryEvidence } from "@/lib/mcp-project-materials";
import { contextPageInput } from "./content-tools";
import { edit, id, json, key, read, revision, write } from "./records";
import { requireReads } from "./source-access";
import type { McpTools } from "./tools";

export function registerProjectMaterialTools(tools: McpTools) {
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
  tools.register("capture_project_repository", { title: "采集项目仓库证据", description: "按配置索引采集受限源码快照并持久保存；不运行 CLI 或模型。返回采集回执，用 get_repository_capture 完整读取范围和片段。", inputSchema: z.strictObject({ projectId: id, repositoryIndex: z.number().int().min(0).max(31), expectedCatalogRevision: revision, expectedProjectRevision: revision, idempotencyKey: key }), annotations: write }, async (input, ctx) => {
    materialReads(); requireReads(tools, "get_repository_catalog"); return json(await captureProjectRepository(input, ctx.mcpReq.signal));
  });
  tools.register("get_repository_capture", { title: "读取仓库采集快照", description: "用幂等键完整分页读取保存的源码、文件定位、摘要及截断范围；重连后读取同一份快照。移出允许目录后禁止读取。", inputSchema: z.strictObject({ idempotencyKey: key, ...contextPageInput }), annotations: read }, async ({ idempotencyKey, ...page }) => {
    materialReads(); requireReads(tools, "get_repository_catalog"); return json(getRepositoryCapture(idempotencyKey, page));
  });
  tools.register("save_repository_evidence", { title: "将仓库证据保存为项目材料", description: "选择采集快照中的 fileIndexes，保存带定位、采集时间和 SHA-256 的原文片段。要求采集及当前项目修订，保留截断说明。", inputSchema: z.strictObject({ projectId: id, captureKey: key, fileIndexes: z.array(z.number().int().min(0).max(10_000)).min(1).max(20), expectedCaptureRevision: revision, expectedProjectRevision: revision, idempotencyKey: key }), annotations: write }, async input => {
    materialReads(); requireReads(tools, "get_repository_capture", "get_repository_catalog"); return json(saveRepositoryEvidence(input));
  });
}
