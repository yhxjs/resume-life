import * as z from "zod/v4";
import { toolAccess } from "./config.mjs";
import type { McpTools } from "./tools";
import { boundMcpOutput } from "@/lib/mcp-output";
import { getMcpApplicationStats, getMcpPriorities, getMcpRecord, listMcpCollection, listMcpOperations, readMcpRecordSection, MCP_RECORD_KINDS, type McpCollection, type McpRecordKind } from "@/lib/mcp-records";
import { createMcpApplication, createMcpPreparationTask, scheduleMcpInterview } from "@/lib/mcp-write";
import { McpOperationError, MCP_ERROR_CODES } from "@/lib/mcp-errors";

export const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const page = { limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(200).optional() };
export const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).describe("本次操作的唯一幂等键；重试时使用同一键和原始参数");
export const read = { readOnlyHint: true, destructiveHint: false };
export const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
/** Updates can replace or clear existing data; creation tools remain additive. */
export const edit = { ...write, destructiveHint: true };
export function json(value: object) { return { content: [{ type: "text" as const, text: JSON.stringify(boundMcpOutput(value)) }] }; }

const sourceTools: Record<McpRecordKind, (keyof typeof toolAccess)[]> = {
  resume: ["get_resume"], project: ["get_project"], project_material: ["list_project_materials"], application: ["get_application"],
  application_submission: ["get_application", "get_resume"], application_interview: ["list_application_interviews"],
  application_interview_questions: ["get_application_interview_questions"],
  interview: ["get_interview"], interview_turn: ["get_interview"], practice_session: ["list_practice_sessions"], practice_question: ["get_practice_question"],
  interview_review: ["get_interview_review"], notebook: ["get_notebook_entry"], ai_draft: ["get_ai_draft"],
  resume_diagnosis: ["get_resume_diagnosis"], jd_portrait: ["get_jd_portrait"], intro: ["get_intro"], interview_series: ["get_interview_series"],
  ai_workflow_context: ["get_ai_workflow_context"], review_card: ["get_review_card"], review_attempt: ["get_review_card"], review_submission: ["get_review_submission"],
};

export function assertWorkflowRead(tools: McpTools, kind: "jd" | "diagnosis" | "review") {
  if (!tools.permits("get_application") || (kind !== "jd" && !tools.permits("get_resume")) ||
    (kind === "review" && !tools.permits("get_application_interview_questions"))) throw new McpOperationError("FORBIDDEN", "AI 上下文所需的岗位、简历或逐题读取能力未授权");
}

export function registerRecordTools(tools: McpTools) {
  for (const [name, kind, title] of [
    ["list_project_materials", "project_materials", "列出项目全部材料"], ["list_resume_versions", "resume_versions", "列出简历全部版本"],
    ["list_application_history", "application_history", "列出投递阶段历史"], ["list_preparation_tasks", "preparation_tasks", "列出投递准备待办"],
    ["list_application_interviews", "application_interviews", "列出投递面试轮次"],
  ] as const) {
    tools.register(name, { title, description: "按记录 ID 倒序分页，parentId 为所属项目、简历或投递 ID。长正文可使用 read_record_section 分段读取。",
      inputSchema: z.strictObject({ parentId: id, ...page }), annotations: read }, async ({ parentId, ...input }) => json(listMcpCollection(kind as McpCollection, parentId, input)));
  }
  tools.register("list_mcp_operations", { title: "读取 MCP 操作记录", description: "读取最近调用元数据，可按错误回执中的 requestId、固定工具名、错误码、状态或目标 ID 筛选；多个条件同时满足。",
    inputSchema: z.strictObject({ ...page, requestId: z.uuid().optional(), tool: z.enum([...Object.keys(toolAccess), "unknown"]).optional(), errorCode: z.enum(MCP_ERROR_CODES).optional(), status: z.enum(["success", "error"]).optional(), targetId: id.optional() }),
    annotations: read }, async input => json(listMcpOperations(input)));
  for (const [name, kind, title, idSource] of [
    ["get_practice_question", "practice_question", "读取练习题详情", "list_practice_questions 返回的 id"],
    ["get_interview_review", "interview_review", "读取面试复盘详情", "list_interview_reviews 返回的 id"],
    ["get_notebook_entry", "notebook", "读取错题详情", "list_notebook 返回的 id"],
    ["get_ai_draft", "ai_draft", "读取 AI 草稿", "生成工具返回的 draftId"],
  ] as const) {
    tools.register(name, { title, description: `用${idSource}读取记录详情摘要及完整内容读取入口。`,
      inputSchema: z.strictObject({ id }), annotations: read }, async ({ id }) => json(getMcpRecord(kind, id)));
  }
  tools.register("read_record_section", { title: "分段读取完整资料", description: "返回完整记录 JSON 的连续片段。首次 offset=0；后续使用 nextOffset 和 revision 作为 expectedRevision，直到 nextOffset=null。拼接 text 后解析 JSON；资料变化时从头重读。",
    inputSchema: z.strictObject({ kind: z.enum(MCP_RECORD_KINDS), id, versionId: id.optional(), workflowKind: z.enum(["jd", "diagnosis", "review"]).optional(), interviewId: id.optional(), requestId: z.uuid().optional(), timeZone: z.string().max(100).optional(), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      length: z.number().int().min(1).max(4000).optional(), expectedRevision: revision.optional() }), annotations: read }, async input => {
    if (!tools.permits(...sourceTools[input.kind])) throw new McpOperationError("FORBIDDEN", "对应资料读取工具未在白名单内");
    if (input.kind === "ai_workflow_context" && input.workflowKind) assertWorkflowRead(tools, input.workflowKind);
    return json(readMcpRecordSection(input));
  });
  tools.register("get_today_priorities", { title: "读取今日优先事项", description: "复用首页优先事项，返回近期面试、资料缺口和到期复习。可指定 IANA 时区。",
    inputSchema: z.strictObject({ timeZone: z.string().max(100).optional() }), annotations: read }, async ({ timeZone }) => json(getMcpPriorities(timeZone)));
  tools.register("get_application_stats", { title: "读取投递统计", description: "读取投递阶段数量、转化率及近期面试摘要。",
    inputSchema: z.strictObject({}), annotations: read }, async () => json(getMcpApplicationStats()));

  tools.register("create_application", { title: "创建投递", description: "创建意向或已投递岗位。可绑定简历发布版本；首次创建和幂等重试均仅返回记录 ID。",
    inputSchema: z.strictObject({ idempotencyKey: key, company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(200),
      stage: z.enum(["interested", "applied"]).default("interested"), resume_id: id.optional(), resume_version_id: id.optional(),
      jd: z.string().max(20_000).default(""), notes: z.string().max(20_000).default("") }), annotations: write },
    async input => json(createMcpApplication(input)));
  tools.register("create_preparation_task", { title: "添加准备待办", description: "为投递添加自定义待办；expectedRevision 使用 get_application 返回的 application.revision，dueTime 使用带时区 ISO 时间。仅返回待办 ID。",
    inputSchema: z.strictObject({ applicationId: id, expectedRevision: revision, idempotencyKey: key, title: z.string().trim().min(1).max(200), dueTime: z.string().max(40).optional() }), annotations: write },
    async input => json(createMcpPreparationTask(input)));
  tools.register("schedule_application_interview", { title: "安排面试", description: "为投递安排面试轮次；要求最新投递 revision、幂等键和带时区 ISO 面试时间。仅返回轮次 ID。",
    inputSchema: z.strictObject({ applicationId: id, expectedRevision: revision, idempotencyKey: key, round_name: z.string().trim().min(1).max(200),
      interview_time: z.string().min(1).max(40), interviewer: z.string().max(200).optional(), location: z.string().max(200).optional(),
      meeting_url: z.url({ protocol: /^https?$/ }).max(2000).optional(), notes: z.string().max(20_000).optional() }), annotations: write }, async input => json(scheduleMcpInterview(input)));
}
