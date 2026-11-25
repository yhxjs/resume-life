import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import type { ReverseInterviewData } from "@/lib/interview";
import { loadReverseInterviewContext } from "@/lib/interview-reverse-context";
import { ResumeContextError } from "@/lib/resume-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { parseReverseInterviewResponse, type ReverseInterviewResponse } from "@/lib/model-protocol";
import { buildReverseInterviewMessages, reverseInterviewPrompt } from "@/lib/interview-reverse-llm";
import { storeInterviewReverse } from "@/lib/interview-training-store";

type InterviewRow = {
  id: number;
  resume_id: number;
  resume_version_id: number | null;
  jd: string;
  style: string;
  status: string;
  report: string;
  reverse_interview: string;
};

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const interviewId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(interviewId) || interviewId <= 0) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "提问内容不能为空" }, { status: 400 });
  }

  const release = acquireCommandLock(`interview-answer:${interviewId}`);
  if (!release) return NextResponse.json({ error: "本场面试正在处理回答或报告，请稍后重试" }, { status: 409 });
  try {
    if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
    const db = getDb();
    const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, style, status, report, reverse_interview FROM interviews WHERE id = ?");
    const interview = interviewQuery.get(interviewId) as InterviewRow | undefined;

    if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });
    if (interview.report) {
      return NextResponse.json({ error: "总结报告已生成，无法再进行反问" }, { status: 400 });
    }
    if (interview.reverse_interview) {
      return NextResponse.json({ error: "该场面试的反问环节已完成" }, { status: 400 });
    }

    const generationContext = loadReverseInterviewContext(interview);
    const { resumeContext, turns } = generationContext;
    const contextSnapshot = JSON.stringify(generationContext);

    const messages = buildReverseInterviewMessages({ jd: interview.jd, resumeContext, turns, question });

    let raw = "";
    try {
      checkModelField(interview.jd, "岗位要求（JD）");
      checkModelField(question, "反问");
      raw = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.interviewReverse, entity: { type: "interview", id: interviewId } },
        reverseInterviewPrompt(generationContext.persona),
        messages,
        { signal: req.signal, requireJson: "strict" },
      );
    } catch (err) {
      if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
    }

    let parsed: ReverseInterviewResponse;
    try {
      parsed = parseReverseInterviewResponse(raw);
    } catch (err) {
      return NextResponse.json(
        { error: `AI 反问评估异常：${errorMessage(err)}` },
        { status: 502 }
      );
    }

    const reverseData: ReverseInterviewData = {
      question,
      answer: parsed.answer,
      evaluation: parsed.evaluation,
      created_at: now(),
    };

    // 模型等待期间不持有事务；事务内同时复核外发材料与提交条件。
    const status = inTransaction(() => {
      if (req.signal.aborted) return 499;
      const current = interviewQuery.get(interviewId) as InterviewRow | undefined;
      if (!current || current.status !== interview.status || current.report || current.reverse_interview) return 409;
      try {
        if (JSON.stringify(loadReverseInterviewContext(current)) !== contextSnapshot) return 409;
      } catch (error) {
        // 发布材料在生成期间损坏，也不能将旧结果保存成当前材料的评价。
        if (error instanceof ResumeContextError || error instanceof SyntaxError || error instanceof TypeError) return 409;
        throw error;
      }
      return storeInterviewReverse(interviewId, interview.status, reverseData) ? 200 : 409;
    });
    if (status !== 200) {
      return NextResponse.json({ error: status === 499 ? "请求已取消" : "面试状态、岗位或背景材料已变更，请刷新后重试" }, { status });
    }

    return NextResponse.json({
      ok: true,
      interview_id: interviewId,
      reverse: reverseData,
    });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/[id]/reverse", handlePost);
