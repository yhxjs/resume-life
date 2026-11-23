import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { captureInterviewResumeContext } from "@/lib/interview-resume-context";
import {
  normalizeEvaluatorReport,
  validateGeneratedEvaluatorReport,
  type EvaluatorReport,
} from "@/lib/scores";
import { interviewStyleOf } from "@/lib/interview";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { buildInterviewEvaluatorMessages, buildInterviewEvaluatorPrompt } from "@/lib/interview-evaluator-llm";
import { errorMessage } from "@/lib/error-message";
import { answeredInterviewReportParts, reverseInterviewReportParts } from "@/lib/interview-report-context";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const interviewId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(interviewId) || interviewId <= 0) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }
  const release = acquireCommandLock(`interview-answer:${interviewId}`);
  if (!release) return NextResponse.json({ error: "本场面试正在处理回答或报告，请稍后重试" }, { status: 409 });
  try {
    if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
    const db = getDb();
    const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, style, status, report, evaluator_report, reverse_interview FROM interviews WHERE id = ?");
    const interview = interviewQuery.get(interviewId) as
      | {
          id: number;
          resume_id: number; resume_version_id: number | null;
          jd: string;
          rounds: number;
          style: string;
          status: string;
          report: string;
          evaluator_report: string;
          reverse_interview: string;
        }
      | undefined;
    if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });
    if (interview.evaluator_report) {
      try {
        const existing = normalizeEvaluatorReport(JSON.parse(interview.evaluator_report));
        if (existing) return NextResponse.json({ evaluator_report: existing });
      } catch { /* 缺失或损坏的面试官评估允许独立重试。 */ }
    }

    const turnsQuery = db.prepare(
      "SELECT idx, kind, question, answer, comment, scores FROM interview_turns WHERE interview_id = ? AND answered_at != '' ORDER BY idx, id"
    );
    const turns = turnsQuery.all(interviewId) as {
      idx: number;
      kind: string;
      question: string;
      answer: string;
      comment: string;
      scores: string;
    }[];
    if (turns.length === 0) {
      return NextResponse.json({ error: "还没有任何作答，无法生成录用评估报表" }, { status: 400 });
    }

    const turnParts = answeredInterviewReportParts(turns);

    const resumeMaterial = captureInterviewResumeContext(interview.resume_id, interview.resume_version_id, "（简历已删除）");
    const resumeContext = resumeMaterial.text;

    const reverseParts = reverseInterviewReportParts(interview.reverse_interview);

    const styleInfo = interviewStyleOf(interview.style);

    let raw = "";
    try {
      checkModelField(interview.jd, "岗位要求（JD）");
      raw = await safeChat("evaluate", { feature: LLM_FEATURES.interviewEvaluatorReport, entity: { type: "interview", id: interviewId } },
        buildInterviewEvaluatorPrompt(styleInfo.label),
        buildInterviewEvaluatorMessages({ jd: interview.jd, resumeContext, turnParts, reverseParts }),
        {
          signal: req.signal,
          requireJson: "strict"
        });
    } catch (err) {
      if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
    }

    let evaluatorReport: EvaluatorReport | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      evaluatorReport = validateGeneratedEvaluatorReport(parsed, turns.map((turn) => turn.idx));
    } catch {
      evaluatorReport = null;
    }

    if (!evaluatorReport) {
      return NextResponse.json({ error: "AI 生成录用评估报表结果异常，请重试" }, { status: 502 });
    }

    const status = inTransaction(() => {
      if (req.signal.aborted) return 499;
      if (JSON.stringify(interviewQuery.get(interviewId)) !== JSON.stringify(interview) ||
          !resumeMaterial.isCurrent() ||
          JSON.stringify(turnsQuery.all(interviewId)) !== JSON.stringify(turns)) return 409;
      db.prepare("UPDATE interviews SET evaluator_report = ? WHERE id = ?").run(JSON.stringify(evaluatorReport), interviewId);
      return 200;
    });
    if (status !== 200) {
      return NextResponse.json({ error: status === 499 ? "请求已取消" : "面试状态、背景材料或问答已变更，请刷新后重试评估" }, { status });
    }

    return NextResponse.json({ evaluator_report: evaluatorReport });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/[id]/evaluator-report", handlePost);
