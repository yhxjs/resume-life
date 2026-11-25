import * as z from "zod/v4";
import { getDiagnosisAdoptionContext, previewDiagnosisAdoption, saveDiagnosisAdoption } from "@/lib/mcp-diagnosis-adoption";
import { getResumeVersionContext, compareResumeVersions, publishMcpResumeVersion, previewResumeVersionBranch, branchMcpResumeVersion } from "@/lib/mcp-resume-versions";
import { getResumeLayoutContext, previewResumeLayout, saveResumeLayout } from "@/lib/mcp-resume-layout";
import { contextPageInput } from "./content-tools";
import { edit, id, json, key, read, revision, write } from "./records";
import { requireReads } from "./source-access";
import type { McpTools } from "./tools";

export function registerResumeLifecycleTools(tools: McpTools) {
  const layoutReads = () => requireReads(tools, "get_resume", "get_resume_layout_context");
  const moduleKey = z.string().min(1).max(100);
  const layout = { resumeId: id, expectedRevision: revision, removeKeys: z.array(moduleKey).max(30).optional(), moduleOrder: z.array(moduleKey).max(30).optional(), template: z.string().max(100).optional(), styleOverrides: z.record(z.string(), z.json()).optional() };
  tools.register("get_resume_layout_context", { title: "读取简历排版上下文", description: "完整读取模块顺序、内置及自定义模板、可用样式字段；包含当前草稿来源令牌。", inputSchema: z.strictObject({ resumeId: id, ...contextPageInput }), annotations: read }, async ({ resumeId, ...page }) => {
    layoutReads(); return json(getResumeLayoutContext(resumeId, page));
  });
  tools.register("preview_resume_layout", { title: "预览模块及排版修改", description: "支持移除模块、完整排序、模板切换和样式覆盖；分页返回实际保存内容与解析后样式。", inputSchema: z.strictObject({ ...layout, page: z.strictObject(contextPageInput).optional() }), annotations: read }, async ({ page = {}, ...input }) => {
    layoutReads(); return json(previewResumeLayout(input, page));
  });
  tools.register("save_resume_layout", { title: "保存已预览排版", description: "重发提案、来源修订及预览令牌；仅修改草稿，历史发布版不变。", inputSchema: z.strictObject({ ...layout, previewToken: revision, idempotencyKey: key }), annotations: edit }, async input => {
    layoutReads(); requireReads(tools, "preview_resume_layout"); return json(saveResumeLayout(input));
  });
  const adoptionSource = { resumeId: id, diagnosisId: id };
  const adoption = { ...adoptionSource, expectedRevision: revision, selections: z.array(z.strictObject({ moduleKey: z.string().min(1).max(100), suggestionIndex: z.number().int().min(0).max(1000), value: z.union([z.string().min(1).max(20_000), z.array(z.string().min(1).max(2000)).min(1).max(100)]).optional() })).min(1).max(50) };
  const adoptionReads = () => requireReads(tools, "get_resume", "get_resume_diagnosis", "get_diagnosis_adoption_context");
  tools.register("get_diagnosis_adoption_context", { title: "读取诊断采纳上下文", description: "完整读取当前草稿、诊断快照、建议及已采纳历史；revision 同时绑定诊断与草稿。", inputSchema: z.strictObject({ ...adoptionSource, ...contextPageInput }), annotations: read }, async ({ resumeId, diagnosisId, ...page }) => {
    adoptionReads(); return json(getDiagnosisAdoptionContext(resumeId, diagnosisId, page));
  });
  tools.register("preview_diagnosis_adoption", { title: "预览诊断建议采纳", description: "选择建议，可提供修订后的 value；返回字段修改前后内容和 previewToken，多个建议不能覆盖同一字段。", inputSchema: z.strictObject({ ...adoption, page: z.strictObject(contextPageInput).optional() }), annotations: read }, async ({ page = {}, ...input }) => {
    adoptionReads(); return json(previewDiagnosisAdoption(input, page));
  });
  tools.register("save_diagnosis_adoption", { title: "保存诊断采纳与草稿", description: "重发已预览提案与令牌，在同一事务保存草稿和采纳记录；重试使用原幂等键。", inputSchema: z.strictObject({ ...adoption, previewToken: revision, idempotencyKey: key }), annotations: edit }, async input => {
    adoptionReads(); requireReads(tools, "preview_diagnosis_adoption"); return json(saveDiagnosisAdoption(input));
  });
  const versionReads = () => requireReads(tools, "get_resume", "list_resume_versions", "get_resume_version_context");
  tools.register("get_resume_version_context", { title: "读取简历版本操作上下文", description: "完整读取草稿、版本元数据及可选选定发布版。发布不传 versionId；历史版继续编辑传 versionId。", inputSchema: z.strictObject({ resumeId: id, versionId: id.optional(), ...contextPageInput }), annotations: read }, async ({ resumeId, versionId, ...page }) => {
    versionReads(); return json(getResumeVersionContext(resumeId, versionId, page));
  });
  tools.register("compare_resume_versions", { title: "比较简历版本", description: "比较同一简历的两个版本；任一侧省略版本 ID 表示当前草稿。完整分页返回正文、排序和排版差异。", inputSchema: z.strictObject({ resumeId: id, beforeVersionId: id.optional(), afterVersionId: id.optional(), page: z.strictObject(contextPageInput).optional() }), annotations: read }, async ({ page = {}, ...input }) => {
    versionReads(); return json(compareResumeVersions(input, page));
  });
  tools.register("publish_resume_version", { title: "发布命名简历版本", description: "按 get_resume_version_context 的 revision 冻结当前正文和排版；返回发布版本 ID，可绑定投递。相同幂等键不会重复发布。", inputSchema: z.strictObject({ resumeId: id, expectedRevision: revision, name: z.string().trim().min(1).max(80), description: z.string().max(2000).optional(), idempotencyKey: key }), annotations: write }, async input => {
    versionReads(); return json(publishMcpResumeVersion(input));
  });
  const branch = { resumeId: id, versionId: id, expectedRevision: revision };
  tools.register("preview_resume_version_branch", { title: "预览历史版本写回草稿", description: "查看当前草稿将被指定历史版替换的完整差异；预览不写入。", inputSchema: z.strictObject({ ...branch, page: z.strictObject(contextPageInput).optional() }), annotations: read }, async ({ page = {}, ...input }) => {
    versionReads(); return json(previewResumeVersionBranch(input, page));
  });
  tools.register("branch_resume_version", { title: "从历史版本继续编辑", description: "将已预览历史版写入当前草稿并保留其排版。原发布版、投递快照不变；需要最新来源和预览令牌。", inputSchema: z.strictObject({ ...branch, previewToken: revision, idempotencyKey: key }), annotations: edit }, async input => {
    versionReads(); requireReads(tools, "preview_resume_version_branch"); return json(branchMcpResumeVersion(input));
  });
}
