import * as z from "zod/v4";
import type { McpTools } from "./tools";
import { generateMcpDraft, saveMcpDraft } from "@/lib/mcp-ai";
import { id, revision, write, json } from "./records";

const generate = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

export function registerWorkflowTools(tools: McpTools) {
  for (const [name, kind, title] of [
    ["analyze_application_jd", "jd", "分析岗位 JD"],
    ["diagnose_application_resume", "diagnosis", "诊断投递简历"],
  ] as const) {
    tools.register(name, { title, description: "使用当前配置模型生成草稿。资料将发送给模型；草稿临时保留 24 小时，业务资料须另调用 save_ai_draft 保存。生成过程中可取消，来源变化时拒绝结果。",
      inputSchema: z.strictObject({ applicationId: id }), annotations: generate }, async ({ applicationId }, ctx) => json(await generateMcpDraft(kind, applicationId, ctx.mcpReq.signal)));
  }
  tools.register("draft_interview_review", { title: "生成面试复盘草稿", description: "根据已保存的逐题记录和投递快照生成可检查的复盘草稿，不直接写入正式复盘。",
    inputSchema: z.strictObject({ applicationId: id, interviewId: id }), annotations: generate }, async ({ applicationId, interviewId }, ctx) => json(await generateMcpDraft("review", applicationId, ctx.mcpReq.signal, interviewId)));
  tools.register("save_ai_draft", { title: "保存已检查的 AI 草稿", description: "将服务保存的 JD、简历诊断或面试复盘草稿写入业务资料并关联投递；expectedRevision 必须为该草稿的 sourceRevision。来源变化时拒绝保存，草稿在有效期内且仍保留时，重复保存返回同一记录。",
    inputSchema: z.strictObject({ draftId: id, expectedRevision: revision }), annotations: write }, async ({ draftId, expectedRevision }) => json(saveMcpDraft(draftId, expectedRevision)));
}
