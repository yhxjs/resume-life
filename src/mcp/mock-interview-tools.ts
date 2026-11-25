import * as z from "zod/v4";
import { answerMockInterview, finishMockInterview, readMockState, startMockInterview } from "@/lib/mcp-mock-interview";
import { INTERVIEW_REPORT_OUTPUT_LIMITS as R, EVALUATOR_REPORT_OUTPUT_LIMITS as E } from "@/lib/scores";
import { INTERVIEW_ANSWER_OUTPUT_LIMITS } from "@/lib/model-protocol";
import { INTERVIEW_QUESTION_MAX_CHARS } from "@/lib/prompt-guidelines";
import { DEFAULT_INTERVIEW_ROUNDS } from "@/lib/interview";
import { requireReads } from "./source-access";
import { scoreFields } from "./practice-tools";
import { id, json, key, read, revision, write } from "./records";
import type { McpTools } from "./tools";

const text = (max: number) => z.string().min(1).max(max);
const miningText = z.string().max(R.miningText);
const reportSchema = z.strictObject({ jd_match: z.number().int().min(0).max(10), strengths: text(R.summaryText), weaknesses: text(R.summaryText), suggestions: text(R.summaryText),
  mining_summary: z.strictObject({ project_name: miningText, background: miningText, actions: miningText, tradeoffs: miningText, results: miningText, contribution: miningText,
    pending_confirmations: z.array(z.strictObject({ category: text(R.pendingCategory), item: text(R.pendingItem), source_hint: text(R.pendingSourceHint) })).max(R.pendingConfirmations),
    resume_bullets: z.array(text(R.resumeBullet)).max(R.resumeBullets) }).optional(),
  evaluator_report: z.strictObject({ recommendation: z.enum(["Strong Hire", "Hire", "Lean No", "No Hire"]), level: text(E.level), level_justification: text(E.levelJustification), summary_for_hr: text(E.summaryForHr),
    hire_reasons: z.array(text(E.hireReason)).max(E.listItems), concerns_and_risks: z.array(text(E.concern)).max(E.listItems), placement_suggestion: text(E.placementSuggestion),
    evidence_quotes: z.array(z.strictObject({ turn_idx: id, topic: text(E.topic), observation: text(E.observation) })).max(E.evidenceItems) }).optional() });

export function registerMockInterviewTools(tools: McpTools) {
  const reads = () => requireReads(tools, "get_interview", "get_resume");
  tools.register("get_mock_interview_state", { title: "继续单场模拟面试", description: "返回当前回合、作答数、报告状态和 revision；用 get_interview 分页取问答，get_resume 取对应版本。仅限单场。",
    inputSchema: z.strictObject({ interviewId: id }), annotations: read }, async ({ interviewId }) => { reads(); return json(readMockState(interviewId)); });
  tools.register("start_mock_interview", { title: "创建单场模拟面试", description: "外部 Agent 提供首题。先用 get_resume({id,versionId}) 读取指定发布版及 resume.revision；开场不调用服务端模型。",
    inputSchema: z.strictObject({ resumeId: id, versionId: id, expectedRevision: revision, jd: z.string().trim().min(1).max(20_000), rounds: z.number().int().min(1).max(30).default(DEFAULT_INTERVIEW_ROUNDS),
      style: z.enum(["gentle", "stress", "deep", "manager", "hr", "mining"]).default("gentle"), firstQuestion: text(INTERVIEW_QUESTION_MAX_CHARS), idempotencyKey: key }), annotations: write },
  async input => { requireReads(tools, "get_resume"); return json(startMockInterview(input)); });
  tools.register("answer_mock_interview", { title: "提交单场面试原答并推进回合", description: "使用当前状态的 revision 和 turnId，提交原答、外部点评和下一题。末题使用空 next_question。返回已答回合 ID；重连后重新查询状态。",
    inputSchema: z.strictObject({ interviewId: id, turnId: id, expectedRevision: revision, answer: z.string().trim().min(1).max(20_000), idempotencyKey: key,
      evaluation: z.strictObject({ ...scoreFields, comment: text(INTERVIEW_ANSWER_OUTPUT_LIMITS.comment), next_kind: z.enum(["question", "followup"]), next_question: z.string().max(INTERVIEW_QUESTION_MAX_CHARS) }) }), annotations: write },
  async input => { reads(); requireReads(tools, "get_mock_interview_state"); return json(answerMockInterview(input)); });
  tools.register("finish_mock_interview", { title: "结束单场模拟面试并保存报告", description: "至少完成一题后可提前结束。外部 Agent 提供总结；mining 风格必须附挖掘总结，四维平均分由服务端计算。不会覆盖已有报告。",
    inputSchema: z.strictObject({ interviewId: id, expectedRevision: revision, report: reportSchema, idempotencyKey: key }), annotations: write },
  async input => { reads(); requireReads(tools, "get_mock_interview_state"); return json(finishMockInterview(input)); });
}
