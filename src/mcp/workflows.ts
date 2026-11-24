import * as z from "zod/v4";
import type { McpTools } from "./tools";
import { generateMcpDraft, saveMcpDraft } from "@/lib/mcp-ai";
import { id, revision, key, page, read, write, json } from "./records";
import { getMcpGenerationRequest, listMcpDrafts } from "@/lib/mcp-generation";

const generate = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

export function registerWorkflowTools(tools: McpTools) {
  for (const [name, kind, title] of [
    ["analyze_application_jd", "jd", "分析岗位 JD"],
    ["diagnose_application_resume", "diagnosis", "诊断投递简历"],
  ] as const) {
    tools.register(name, { title, description: "使用当前配置模型生成草稿。资料将发送给模型；草稿临时保留 24 小时，业务资料须另调用 save_ai_draft 保存。生成过程中可取消，来源变化时拒绝结果。",
      inputSchema: z.strictObject({ applicationId: id, idempotencyKey: key.optional().describe("预先保存的生成请求幂等键；同一键重试不会再次调用模型") }), annotations: generate }, async ({ applicationId, idempotencyKey }, ctx) => json(await generateMcpDraft(kind, applicationId, ctx.mcpReq.signal, undefined, idempotencyKey)));
  }
  tools.register("draft_interview_review", { title: "生成面试复盘草稿", description: "根据已保存的逐题记录和投递快照生成可检查的复盘草稿，不直接写入正式复盘。",
    inputSchema: z.strictObject({ applicationId: id, interviewId: id, idempotencyKey: key.optional() }), annotations: generate }, async ({ applicationId, interviewId, idempotencyKey }, ctx) => json(await generateMcpDraft("review", applicationId, ctx.mcpReq.signal, interviewId, idempotencyKey)));
  tools.register("save_ai_draft", { title: "保存已检查的 AI 草稿", description: "将服务保存的 JD、简历诊断或面试复盘草稿写入业务资料并关联投递；expectedRevision 必须为该草稿的 sourceRevision。来源变化时拒绝保存，草稿在有效期内且仍保留时，重复保存返回同一记录。",
    inputSchema: z.strictObject({ draftId: id, expectedRevision: revision }), annotations: write }, async ({ draftId, expectedRevision }) => json(saveMcpDraft(draftId, expectedRevision)));
  tools.register("list_ai_drafts", { title: "找回近期 AI 草稿", description: "按投递或类型分页查看近期草稿的有效期、保存状态和生成请求幂等键。仅返回元数据，正文用 get_ai_draft 读取。可 includeExpired 查看尚未清理的过期元数据。",
    inputSchema: z.strictObject({ ...page, applicationId: id.optional(), kind: z.enum(["jd", "diagnosis", "review"]).optional(), includeExpired: z.boolean().optional() }), annotations: read },
  async input => json(listMcpDrafts(input)));
  tools.register("get_ai_generation_request", { title: "查询 AI 生成请求", description: "通过生成前提供的 idempotencyKey 查找请求状态、可用草稿 ID 和已保存记录 ID。失败或中断的同一键不会自动重新调用模型；正文另用 get_ai_draft 读取。",
    inputSchema: z.strictObject({ idempotencyKey: key }), annotations: read }, async ({ idempotencyKey }) => json(getMcpGenerationRequest(idempotencyKey)));
}
