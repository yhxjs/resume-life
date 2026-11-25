import { getDb, inTransaction, now } from "./db";
import { captureInterviewResumeContext } from "./interview-resume-context";
import { readInterviewRetryHistory } from "./interview-retry-history";
import { interviewFollowupContextParts } from "./interview-followup-context";
import { buildInterviewRetryMessages, RETRY_EVAL_PROMPT } from "./interview-retry-llm";
import { buildInterviewReferenceMessages, INTERVIEW_REFERENCE_PROMPT } from "./interview-reference-llm";
import { buildReverseInterviewMessages, reverseInterviewPrompt } from "./interview-reverse-llm";
import { loadReverseInterviewContext } from "./interview-reverse-context";
import { appendInterviewRetry, storeInterviewReference, storeInterviewReverse } from "./interview-training-store";
import { parseInterviewReference, parseInterviewRetryEvaluation, parseReverseInterviewResponse } from "./model-protocol";
import { assertMcpContext, mcpContextPage, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpCreateOnce } from "./mcp-state";

export type InterviewTrainingSource = { kind: "retry"; interviewId: number; turnId: number; answer: string }
  | { kind: "reference"; interviewId: number; turnId: number }
  | { kind: "reverse"; interviewId: number; question: string };
type Interview = { id: number; resume_id: number; resume_version_id: number | null; jd: string; style: string; status: string; report: string; reverse_interview: string };

function capture(source: InterviewTrainingSource) {
  const db = getDb();
  const interview = db.prepare("SELECT id,resume_id,resume_version_id,jd,style,status,report,reverse_interview FROM interviews WHERE id=?").get(source.interviewId) as Interview | undefined;
  if (!interview) throw new McpOperationError("NOT_FOUND", "面试不存在");
  if (source.kind === "reverse") {
    if (interview.report || interview.reverse_interview) throw new McpOperationError("CONFLICT", "报告或反问已保存，请核对当前状态");
    const context = loadReverseInterviewContext(interview);
    return { source, interview, rules: reverseInterviewPrompt(context.persona),
      messages: buildReverseInterviewMessages({ ...context, question: source.question }) };
  }
  const turn = db.prepare("SELECT id,idx,kind,question,answer,answered_at,comment,scores,reference,retries FROM interview_turns WHERE id=? AND interview_id=?").get(source.turnId, source.interviewId) as
    { id: number; idx: number; kind: string; question: string; answer: string; answered_at: string; comment: string; scores: string; reference: string; retries: string } | undefined;
  if (!turn) throw new McpOperationError("NOT_FOUND", "题目不存在或不属于本场面试");
  if (source.kind === "retry" && !readInterviewRetryHistory(turn.retries)) throw new McpOperationError("INVALID_ARGUMENT", "重答历史损坏，请先核对原记录");
  const resumeContext = captureInterviewResumeContext(interview.resume_id, interview.resume_version_id, "（简历未提供或已删除）").text;
  const common = { jd: interview.jd, resumeContext, followupParts: interviewFollowupContextParts(interview.id, turn), turn: { idx: turn.idx, question: turn.question } };
  return { source, interview, turn, rules: source.kind === "retry" ? RETRY_EVAL_PROMPT : INTERVIEW_REFERENCE_PROMPT,
    messages: source.kind === "retry" ? buildInterviewRetryMessages({ ...common, priorAnswer: turn.answer, answer: source.answer }) : buildInterviewReferenceMessages({ ...common, answer: turn.answer }) };
}

export function getInterviewTrainingContext(source: InterviewTrainingSource, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(source), page));
}

export function saveInterviewTrainingResult(input: { source: InterviewTrainingSource; expectedRevision: string; result: object; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_interview_training_result", idempotencyKey, payload, () => {
    const source = input.source, context = capture(source);
    assertMcpContext(context, input.expectedRevision);
    if (source.kind === "retry") {
      const { comment, reference, ...scores } = parseInterviewRetryEvaluation(JSON.stringify(input.result));
      appendInterviewRetry(source.interviewId, source.turnId, { id: `retry_mcp_${idempotencyKey}`, answer: source.answer, scores, comment, reference, created_at: now() });
      return { id: source.turnId };
    }
    if (source.kind === "reference") {
      storeInterviewReference(source.interviewId, source.turnId, parseInterviewReference(JSON.stringify(input.result)));
      return { id: source.turnId };
    }
    const result = parseReverseInterviewResponse(JSON.stringify(input.result));
    if (!storeInterviewReverse(source.interviewId, context.interview.status, { ...result, question: source.question, created_at: now() })) {
      throw new McpOperationError("CONFLICT", "面试状态已变化，请重新读取");
    }
    return { id: source.interviewId };
  }, id => input.source.kind === "reverse" ? !!getDb().prepare("SELECT 1 FROM interviews WHERE id=?").get(id) :
    !!getDb().prepare("SELECT 1 FROM interview_turns WHERE id=? AND interview_id=?").get(id, input.source.interviewId));
}
