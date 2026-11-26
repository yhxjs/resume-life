import * as z from "zod/v4";
import { getTemplateContext, createMcpTemplate, previewMcpTemplate, saveMcpTemplate, getAvatarContext, setMcpAvatar } from "@/lib/mcp-template-avatar";
import { contextPageInput } from "./content-tools";
import { edit, id, json, key, read, revision, write } from "./records";
import { requireReads } from "./source-access";
import type { McpTools } from "./tools";

export function registerTemplateAvatarTools(tools: McpTools) {
  const reads = () => requireReads(tools, "get_resume", "get_resume_template_context");
  tools.register("get_resume_template_context", { title: "读取模板及受影响草稿", description: "未传 templateId 时读取内置和自定义模板供创建或复制；传入 ID 时附全部引用草稿和修订令牌。需要简历读取权限。",
    inputSchema: z.strictObject({ templateId: id.optional(), ...contextPageInput }), annotations: read }, async ({ templateId, ...page }) => { reads(); return json(getTemplateContext(templateId, page)); });
  tools.register("create_resume_template", { title: "创建或复制简历模板", description: "从模板目录 revision 创建自定义模板。templateRef 复制现有模板，style 提供完整样式；两者不能同时传。重试不会重复创建。",
    inputSchema: z.strictObject({ name: z.string().trim().min(1).max(30), style: z.record(z.string(), z.json()).optional(), templateRef: z.string().min(1).max(100).optional(), expectedRevision: revision, idempotencyKey: key }), annotations: write },
    async input => { reads(); return json(createMcpTemplate(input)); });
  const proposal = { templateId: id, expectedRevision: revision, name: z.string().trim().min(1).max(30).optional(), style: z.record(z.string(), z.json()).optional() };
  tools.register("preview_resume_template", { title: "预览模板改名和样式编辑", description: "完整展示模板修改前后及每份引用草稿的实际解析样式；已发布版本保持冻结。",
    inputSchema: z.strictObject({ ...proposal, page: z.strictObject(contextPageInput).optional() }), annotations: read }, async ({ page = {}, ...input }) => { reads(); return json(previewMcpTemplate(input, page)); });
  tools.register("save_resume_template", { title: "保存已预览模板修改", description: "重发同一提案和 previewToken；新增引用或样式改变都会使旧预览失效。网页模板工厂复用相同领域写入。",
    inputSchema: z.strictObject({ ...proposal, previewToken: revision, idempotencyKey: key }), annotations: edit }, async input => { reads(); requireReads(tools, "preview_resume_template"); return json(saveMcpTemplate(input)); });
  tools.register("get_resume_avatar_context", { title: "读取头像替换来源", description: "完整读取当前草稿模块和 revision，选择基本信息模块的 key 作为 moduleKey。",
    inputSchema: z.strictObject({ resumeId: id, ...contextPageInput }), annotations: read }, async ({ resumeId, ...page }) => { requireReads(tools, "get_resume"); return json(getAvatarContext(resumeId, page)); });
  tools.register("set_resume_avatar", { title: "替换或清除简历头像", description: "使用 purpose=avatar 的完整上传，复用网页的魔数校验、旋转和尺寸限制。uploadId=null 清除；只修改指定草稿模块，旧发布版图片仍保留。",
    inputSchema: z.strictObject({ resumeId: id, moduleKey: z.string().min(1).max(100), uploadId: revision.nullable(), expectedRevision: revision, idempotencyKey: key }), annotations: edit },
    async (input, ctx) => { requireReads(tools, "get_resume", "get_resume_avatar_context"); if (input.uploadId !== null) requireReads(tools, "get_mcp_upload"); return json(await setMcpAvatar(input, ctx.mcpReq.signal)); });
}
