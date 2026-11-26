import * as z from "zod/v4";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import type { McpTools } from "./tools";
import { requireReads } from "./source-access";
import { read, edit, json } from "./records";
import { previewResumeDraftRebase, previewApplicationRebase, previewApplicationEdit, saveApplicationEdit } from "@/lib/mcp-rebase";
import { resumeRebaseInputSchema, applicationRebaseInputSchema, applicationPreviewInputSchema, applicationSaveInputSchema } from "@/lib/mcp-rebase-types";

export const REBASE_TOOL_ACCESS = { preview_resume_draft_rebase: "read", preview_application_rebase: "read", preview_application_edit: "read", save_application_edit: "write" } as const;
export { REBASE_INPUT_SCHEMAS, REBASE_OUTPUT_SCHEMAS } from "@/lib/mcp-rebase-types";
export const REBASE_READ_DEPENDENCIES = {
  preview_resume_draft_rebase: ["get_resume_draft_context", "get_resume"],
  preview_application_rebase: ["get_application"], preview_application_edit: ["get_application"], save_application_edit: ["get_application", "preview_application_edit"],
} as const;
/** Minimal registrar shared by the server and isolated domain tests. */
export interface RebaseRegistrar {
  permits: McpTools["permits"];
  register<T extends z.ZodType>(name: keyof typeof REBASE_TOOL_ACCESS, config: { title: string; description: string; inputSchema: T; annotations: ToolAnnotations },
    run: (input: z.output<T>) => Promise<CallToolResult>): void;
}
export function registerRebaseTools(tools: RebaseRegistrar) {
  tools.register("preview_resume_draft_rebase", { title: "三方比较简历草稿", annotations: read, inputSchema: resumeRebaseInputSchema,
    description: "先读 get_resume_draft_context，再用 capture+expectedRevision 冻结服务端 base；rebase 提交 baseToken 和所选模块完整 proposed。返回分页 original/proposed/current、稳定 ID 冲突及 safeProposal。choices 需 currentRevision；prepared 仅是下一步预览参数，不能作为保存令牌。" }, async input => {
    requireReads(tools, "get_resume_draft_context", "get_resume"); return json(previewResumeDraftRebase(input));
  });
  tools.register("preview_application_rebase", { title: "三方比较投递字段", annotations: read, inputSchema: applicationRebaseInputSchema,
    description: "先读 get_application，用 capture+application.revision 固定 base。rebase 对备注/JD/阶段及发布版本绑定三方比较。阶段与终止信息、简历与版本绑定作为耦合字段；冲突需 choices+currentRevision 明确选择，随后重新预览。" }, async input => {
    requireReads(tools, "get_application"); return json(previewApplicationRebase(input));
  });
  tools.register("preview_application_edit", { title: "预览投递字段修改", annotations: read, inputSchema: applicationPreviewInputSchema,
    description: "使用最新投递 revision 预览 fields；复用投递领域校验与规范化，返回分页实际值和 previewToken。全部业务写入回滚，正式投递快照不改变。" }, async ({ page, ...input }) => {
    requireReads(tools, "get_application"); return json(previewApplicationEdit(input, page));
  });
  tools.register("save_application_edit", { title: "保存已预览的投递字段", annotations: edit, inputSchema: applicationSaveInputSchema,
    description: "原样重发预览的 fields、expectedRevision、previewToken 与幂等键。并发变化需重新比较/预览；断线重试同键同参，恢复后旧回执失效；首次投递快照保持固定。" }, async input => {
    requireReads(tools, "get_application", "preview_application_edit");
    return json(saveApplicationEdit(input));
  });
}
