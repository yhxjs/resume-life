import * as z from "zod/v4";
import type { McpTools } from "./tools";
import { id, revision, key, page, json, read, write, edit } from "./records";
import { bookmarkMcpQuestion, getMcpReviewCard, getMcpReviewSubmission, listMcpReviewCards, saveMcpNotebookNote, submitMcpReview } from "@/lib/mcp-review";

export function registerReviewTools(tools: McpTools) {
  tools.register("list_review_cards", { title: "读取到期或全部复习卡片", description: "复用网页端复习排期，按日期和 ID 分页；返回到期统计、当前复习次数和来源。可指定 IANA 时区。",
    inputSchema: z.strictObject({ ...page, scope: z.enum(["due", "all"]).optional(), source: z.enum(["notebook", "remedial", "all"]).optional(), timeZone: z.string().max(100).optional() }), annotations: read },
  async input => json(listMcpReviewCards(input)));
  tools.register("get_review_card", { title: "读取复习题与历史", description: "读取题目、原答、参考和反馈，以及分页复习历史；提交时使用 review_count。完整题目和每条作答分别用各自的 fullContent 读取，更多历史用 nextCursor。",
    inputSchema: z.strictObject({ id, ...page, timeZone: z.string().max(100).optional() }), annotations: read }, async input => json(getMcpReviewCard(input)));
  tools.register("get_review_submission", { title: "核对复习提交", description: "按提交前保存的 requestId 精确查询复习结果；完整结果用 fullContent 分段读取，需保留其中的 requestId。只读，不推进复习次数或排期。",
    inputSchema: z.strictObject({ cardId: id, requestId: z.uuid() }), annotations: read }, async ({ cardId, requestId }) => json(getMcpReviewSubmission(cardId, requestId)));
  tools.register("submit_review", { title: "提交复习回答与自评", description: "使用最新 review_count、唯一 UUID requestId、回答和自评提交复习。重试使用原始参数和同一 requestId，成功后只返回复习记录 ID；结果另用 get_review_submission 核对。",
    inputSchema: z.strictObject({ cardId: id, answer: z.string().trim().min(1).max(20_000), grade: z.enum(["again", "hard", "good", "easy"]),
      expectedReviewCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), requestId: z.uuid(), timeZone: z.string().max(100).optional() }), annotations: write },
  async input => json(submitMcpReview(input)));
  tools.register("bookmark_practice_question", { title: "收藏练习或模拟面试错题", description: "source=drill 时 sourceId 为练习题 ID，source=interview 时为模拟面试回合 ID。复制完整来源快照并关联复习卡；重试不会重复收藏，只返回错题 ID。",
    inputSchema: z.strictObject({ source: z.enum(["drill", "interview"]), sourceId: id, categoryId: id.nullable().optional(), idempotencyKey: key }), annotations: write },
  async input => json(bookmarkMcpQuestion(input)));
  tools.register("save_notebook_note", { title: "保存错题补充笔记", description: "独立保存用户补充笔记；原答与反馈快照保持完整。expectedRevision 使用 get_notebook_entry 返回的 noteRevision，空串表示清空补充内容。重复提交使用同一幂等键，只返回笔记 ID。",
    inputSchema: z.strictObject({ notebookId: id, content: z.string().max(20_000), expectedRevision: revision, idempotencyKey: key }), annotations: edit },
  async input => json(saveMcpNotebookNote(input)));
}
