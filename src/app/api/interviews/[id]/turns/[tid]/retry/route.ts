import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { parseApiJson } from "@/lib/api-request";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now, requestDataGeneration } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { captureInterviewResumeContext } from "@/lib/interview-resume-context";
import { readInterviewRetryHistory, type TurnRetry } from "@/lib/interview-retry-history";
import { ModelProtocolError, parseInterviewRetryEvaluation } from "@/lib/model-protocol";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { randomUUID } from "node:crypto";
import { errorMessage } from "@/lib/error-message";
import { withRouteErrorHandling } from "@/lib/api-route";
import { BackupLimitError } from "@/lib/backup-limits";
import { appendInterviewRetry } from "@/lib/interview-training-store";
import { InterviewCommandError } from "@/lib/interview-commands/errors";
import { interviewFollowupContextParts } from "@/lib/interview-followup-context";
import { buildInterviewRetryMessages, RETRY_EVAL_PROMPT } from "@/lib/interview-retry-llm";

export type { TurnRetry } from "@/lib/interview-retry-history";

function parseRetryHistory(value: string) {
  const history = readInterviewRetryHistory(value);
  if (!history) {
    throw new InterviewCommandError("重答历史数据损坏，已保留原记录，请先检查或恢复备份", 422);
  }
  return history;
}

const pendingRetries = new Set<string>();

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string; tid: string }> }
) {
  const { id, tid } = await params;
  const interviewId = parseCanonicalPositiveId(id);
  const turnId = parseCanonicalPositiveId(tid);
  if (!Number.isSafeInteger(interviewId) || interviewId <= 0 || !Number.isSafeInteger(turnId) || turnId <= 0) {
    return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  }

  const key = req.headers.get("Idempotency-Key");
  if (key !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return NextResponse.json({ error: "无效的重答提交编号" }, { status: 400 });
  }
  const retryId = `retry_${key?.toLowerCase() ?? randomUUID()}`;
  const operation = JSON.stringify([requestDataGeneration(), interviewId, turnId, retryId]);
  if (pendingRetries.has(operation)) {
    return NextResponse.json({ error: "本次重答仍在评分，请稍后使用原提交重试" }, { status: 409 });
  }
  pendingRetries.add(operation);
  try {
    return await evaluateRetry(req, interviewId, turnId, retryId);
  } finally {
    pendingRetries.delete(operation);
  }
}

async function evaluateRetry(req: Request, interviewId: number, turnId: number, retryId: string) {

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { answer?: unknown } | null;
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (!answer) {
    return NextResponse.json({ error: "回答内容不能为空" }, { status: 400 });
  }

  const db = getDb();
  const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, style FROM interviews WHERE id = ?");
  const interview = interviewQuery.get(interviewId) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; style: string }
    | undefined;
  if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });

  const turn = db
    .prepare(
      "SELECT id, idx, kind, question, answer, comment, scores, reference, retries FROM interview_turns WHERE id = ? AND interview_id = ?"
    )
    .get(turnId, interviewId) as
    | {
        id: number;
        idx: number;
        kind: string;
        question: string;
        answer: string;
        comment: string;
        scores: string;
        reference: string;
        retries: string;
      }
    | undefined;
  if (!turn) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  const followupParts = interviewFollowupContextParts(interviewId, turn);

  // 已有历史损坏时不消耗模型调用；提交时仍须重读，以防等待期间历史发生变化。
  try {
    const { retries } = parseRetryHistory(turn.retries);
    const existing = retries.find((retry) => retry?.id === retryId);
    if (existing) {
      if (existing.answer !== answer) {
        return NextResponse.json({ error: "该提交编号已用于其他回答，请重新提交" }, { status: 409 });
      }
      return NextResponse.json({ retry: existing, retries, reference: turn.reference });
    }
  } catch (error) {
    if (!(error instanceof InterviewCommandError)) throw error;
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const resumeMaterial = captureInterviewResumeContext(interview.resume_id, interview.resume_version_id, "（简历未提供或已删除）");
  const resumeContext = resumeMaterial.text;

  let raw = "";
  try {
    checkModelField(interview.jd, "岗位要求（JD）");
    checkModelField(answer, "回答");
    raw = await safeChat("evaluate", { feature: LLM_FEATURES.interviewRetryGrade, entity: { type: "interview", id: interviewId } }, RETRY_EVAL_PROMPT,
      buildInterviewRetryMessages({ jd: interview.jd, resumeContext, followupParts, turn: { idx: turn.idx, question: turn.question }, priorAnswer: turn.answer, answer }),
      { signal: req.signal, requireJson: "strict" });
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let parsed;
  try {
    parsed = parseInterviewRetryEvaluation(raw);
  } catch (error) {
    if (!(error instanceof ModelProtocolError)) throw error;
    return NextResponse.json({ error: `AI 评分结果协议错误：${error.message}` }, { status: 502 });
  }

  const scores = { depth: parsed.depth, structure: parsed.structure, authenticity: parsed.authenticity, completeness: parsed.completeness };
  const comment = parsed.comment;
  const refFromEval = parsed.reference;

  const newRetry: TurnRetry = {
    id: retryId,
    answer,
    scores,
    comment,
    reference: refFromEval || undefined,
    created_at: now(),
  };

  let saved: { retry: TurnRetry; updatedRetries: TurnRetry[]; updatedReference: string } | null;
  try {
    saved = inTransaction(() => {
      const latest = db.prepare(
        "SELECT * FROM interview_turns WHERE id = ? AND interview_id = ?"
      ).get(turnId, interviewId) as (Record<string, unknown> & { retries: string; reference: string }) | undefined;
      if (!latest) return null;
      const { retries } = parseRetryHistory(latest.retries);
      const existing = retries.find((retry) => retry?.id === retryId);
      if (existing) {
        if (existing.answer !== answer) throw new InterviewCommandError("该提交编号已用于其他回答，请重新提交", 409);
        return { retry: existing, updatedRetries: retries, updatedReference: latest.reference };
      }
      // 只核对生成依据；其他重答新增的历史和参考仍从最新行合并，不互相覆盖。
      if (JSON.stringify(interviewQuery.get(interviewId)) !== JSON.stringify(interview) ||
          (["idx", "kind", "question", "answer"] as const).some((key) => latest[key] !== turn[key]) ||
          !resumeMaterial.isCurrent() ||
          JSON.stringify(interviewFollowupContextParts(interviewId, turn)) !== JSON.stringify(followupParts)) {
        throw new InterviewCommandError("面试资料、题目或追问上下文已更新，请刷新后重新作答", 409);
      }
      return appendInterviewRetry(interviewId, turnId, newRetry);
    });
  } catch (error) {
    if (error instanceof InterviewCommandError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof BackupLimitError) {
      return NextResponse.json({ error: "重答历史已达到可备份容量上限，本次回答未保存，原历史已保留" }, { status: 400 });
    }
    throw error;
  }
  if (!saved) return NextResponse.json({ error: "题目不存在" }, { status: 404 });

  return NextResponse.json({
    retry: saved.retry,
    retries: saved.updatedRetries,
    reference: saved.updatedReference,
  });
}

export const POST = withRouteErrorHandling(
  "POST /api/interviews/[id]/turns/[tid]/retry",
  handlePost
);
