import { parseApiJson } from "@/lib/api-request";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import type { ScoreMap } from "@/lib/scores";
import { ModelProtocolError, parseInterviewRetryEvaluation } from "@/lib/model-protocol";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { randomUUID } from "node:crypto";
import { errorMessage } from "@/lib/error-message";
import { withRouteErrorHandling } from "@/lib/api-route";
import { assertBackupFieldBytes, assertBackupRecordBytes, BackupLimitError } from "@/lib/backup-limits";
import { InterviewCommandError } from "@/lib/interview-commands/errors";
import { syncNotebookSnapshot } from "@/lib/notebook";

export type TurnRetry = {
  id: string;
  answer: string;
  scores: ScoreMap | null;
  comment: string;
  reference?: string;
  created_at: string;
};

function parseRetryHistory(value: string): TurnRetry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new InterviewCommandError("重答历史数据损坏，已保留原记录，请先检查或恢复备份", 422);
  }
  if (!Array.isArray(parsed)) {
    throw new InterviewCommandError("重答历史数据损坏，已保留原记录，请先检查或恢复备份", 422);
  }
  return parsed as TurnRetry[];
}

const RETRY_EVAL_PROMPT = `你是严格且专业的面试官。候选人针对面试中曾经回答过的一道题目进行了「重新作答」，请对本次最新回答进行评分与点评。
输出 JSON 格式：
{
  "depth": 0-10 整数,
  "structure": 0-10 整数,
  "authenticity": 0-10 整数,
  "completeness": 0-10 整数,
  "comment": "综合点评，2-3 句中文，指出相比常规作答的亮点与仍可改进之处",
  "reference": "改进版参考答案：结合题目与岗位的高分示范回答"
}
维度定义：
- depth 技术深度（原理、边界条件与技术取舍）；
- structure 结构表达（层次逻辑，行为题看 STAR 完整性）；
- authenticity 真实性（回答是否具体可信、自洽，虚夸空泛给低分并在点评中说明）；
- completeness 完整度（是否全面扣中题干考察点）。
评分需有区分度，切忌千篇一律的高分。只输出 JSON。`;

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string; tid: string }> }
) {
  const { id, tid } = await params;
  const interviewId = Number(id);
  const turnId = Number(tid);
  if (!Number.isInteger(interviewId) || !Number.isInteger(turnId)) {
    return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { answer?: unknown } | null;
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (!answer) {
    return NextResponse.json({ error: "回答内容不能为空" }, { status: 400 });
  }

  const db = getDb();
  const interview = db
    .prepare("SELECT id, resume_id, resume_version_id, jd, style FROM interviews WHERE id = ?")
    .get(interviewId) as
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

  // 已有历史损坏时不消耗模型调用；提交时仍须重读，以防等待期间历史发生变化。
  try {
    parseRetryHistory(turn.retries);
  } catch (error) {
    if (!(error instanceof InterviewCommandError)) throw error;
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  let resumeContext = "";
  try {
    resumeContext = loadResumeContext(interview.resume_id, interview.resume_version_id);
  } catch (error) {
    if (!(error instanceof ResumeNotFoundError)) throw error;
    resumeContext = "（简历未提供或已删除）";
  }

  let raw = "";
  try {
    checkModelField(interview.jd, "岗位要求（JD）");
    checkModelField(answer, "回答");
    raw = await safeChat("evaluate", { feature: LLM_FEATURES.interviewRetryGrade, entity: { type: "interview", id: interviewId } }, RETRY_EVAL_PROMPT, [
      {
        role: "user",
        parts: [
          { trust: "trusted", text: "【岗位要求 JD】\n" },
          {
            trust: "untrusted",
            tag: "job_description",
            text: interview.jd || "（通用岗位）",
          },
          { trust: "trusted", text: "\n\n【候选人简历背景】\n" },
          { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
          { trust: "trusted", text: "\n\n【面试题】\n" },
          {
            trust: "untrusted",
            tag: "interview_question",
            text: JSON.stringify({ idx: turn.idx, question: turn.question }),
          },
          ...(turn.answer
            ? [
                { trust: "trusted", text: "\n\n【原回答（供对比参考）】\n" } as const,
                { trust: "untrusted", tag: "prior_candidate_answer", text: turn.answer } as const,
              ]
            : []),
          { trust: "trusted", text: "\n\n【本次重新作答内容】\n" },
          { trust: "untrusted", tag: "candidate_answer", text: answer },
        ],
      },
    ], { signal: req.signal, requireJson: true });
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
    id: `retry_${randomUUID()}`,
    answer,
    scores,
    comment,
    reference: refFromEval || undefined,
    created_at: now(),
  };

  let saved: { updatedRetries: TurnRetry[]; updatedReference: string } | null;
  try {
    saved = inTransaction(() => {
      const latest = db.prepare(
        "SELECT * FROM interview_turns WHERE id = ? AND interview_id = ?"
      ).get(turnId, interviewId) as (Record<string, unknown> & { retries: string; reference: string }) | undefined;
      if (!latest) return null;
      const updatedRetries = [...parseRetryHistory(latest.retries), newRetry];
      const updatedReference = latest.reference || refFromEval || "";
      const encodedRetries = JSON.stringify(updatedRetries);
      const row = { ...latest, retries: encodedRetries, reference: updatedReference };
      // 与备份流一致，包含整行、外层 JSON 转义和末尾换行，不能只限制单次回答。
      for (const value of Object.values(row)) {
        if (typeof value === "string") assertBackupFieldBytes(Buffer.byteLength(value, "utf8"));
      }
      assertBackupRecordBytes(Buffer.byteLength(`${JSON.stringify({ kind: "row", table: "interview_turns", data: row })}\n`, "utf8"));
      const result = db.prepare(
        "UPDATE interview_turns SET retries = ?, reference = CASE WHEN reference = '' THEN ? ELSE reference END WHERE id = ? AND interview_id = ?"
      ).run(encodedRetries, updatedReference, turnId, interviewId);
      if (result.changes !== 1) throw new Error("重答历史提交失败");
      if (updatedReference) {
        syncNotebookSnapshot(db, "interview", turnId, {
          reference: updatedReference,
        });
      }
      return { updatedRetries, updatedReference };
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
    retry: newRetry,
    retries: saved.updatedRetries,
    reference: saved.updatedReference,
  });
}

export const POST = withRouteErrorHandling(
  "POST /api/interviews/[id]/turns/[tid]/retry",
  handlePost
);
