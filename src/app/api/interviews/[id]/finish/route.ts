import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { captureInterviewResumeContext } from "@/lib/interview-resume-context";
import {
  normalizeCompleteReport,
  validateGeneratedReport,
  validateGeneratedEvaluatorReport,
  type ScoreMap,
} from "@/lib/scores";
import { interviewStyleOf } from "@/lib/interview";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { answeredInterviewReportParts, reverseInterviewReportParts } from "@/lib/interview-report-context";
import { readInterviewOriginalScores } from "@/lib/interview-original-scores";
import { buildInterviewFinishMessages, buildInterviewFinishPrompt, parseInterviewFinishPayload } from "@/lib/interview-finish-llm";

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
    const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, style, status, report, evaluator_report, reverse_interview, finished_at FROM interviews WHERE id = ?");
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
          finished_at: string;
        }
      | undefined;
    if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });
    if (interview.report) {
      try {
        if (normalizeCompleteReport(JSON.parse(interview.report), interview.style === "mining")) {
          return NextResponse.json({ error: "报告已生成" }, { status: 400 });
        }
      } catch { /* 损坏的历史报告允许重新生成。 */ }
    }

    const turnsQuery = db.prepare(
      "SELECT id, idx, kind, question, answer, comment, scores, answered_at FROM interview_turns WHERE interview_id = ? ORDER BY idx, id"
    );
    const allTurns = turnsQuery.all(interviewId) as {
      id: number;
      idx: number;
      kind: string;
      question: string;
      answer: string;
      comment: string;
      scores: string;
      answered_at: string;
    }[];
    const turns = allTurns.filter((turn) => turn.answered_at !== "");
    if (turns.length === 0) {
      return NextResponse.json({ error: "还没有任何作答，无法生成总结报告" }, { status: 400 });
    }

    const scoreMaps: ScoreMap[] = [];
    for (const turn of turns) {
      const original = readInterviewOriginalScores(turn.scores);
      if (!original?.scores) {
        return NextResponse.json({ error: `第 ${turn.idx} 题的原答评分缺失或损坏，无法生成完整报告。请核对原始记录或从有效备份恢复；重答不会补写原评分。` }, { status: 422 });
      }
      scoreMaps.push(original.scores);
    }
    const turnParts = answeredInterviewReportParts(turns);

    const resumeMaterial = captureInterviewResumeContext(interview.resume_id, interview.resume_version_id, "（简历已删除）");
    const resumeContext = resumeMaterial.text;

    const reverseParts = reverseInterviewReportParts(interview.reverse_interview);

    const styleInfo = interviewStyleOf(interview.style);
    const isMining = interview.style === "mining";
    const finishSystemPrompt = buildInterviewFinishPrompt({ isMining, styleLabel: styleInfo.label });

    let raw = "";
    try {
      checkModelField(interview.jd, "岗位要求（JD）");
      raw = await safeChat("evaluate", { feature: LLM_FEATURES.interviewFinish, entity: { type: "interview", id: interviewId } }, finishSystemPrompt,
        buildInterviewFinishMessages({ jd: interview.jd, resumeContext, turnParts, reverseParts }),
        {
          signal: req.signal,
          requireJson: "strict"
        });
    } catch (err) {
      if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
    }

    const parsed = parseInterviewFinishPayload(raw, isMining);
    const jdMatch = parsed?.jd_match;
    const strengths = parsed?.strengths ?? "";
    const weaknesses = parsed?.weaknesses ?? "";
    const suggestions = parsed?.suggestions ?? "";
    const rawMiningSummary = parsed?.mining_summary ?? null;
    const rawEvaluatorReport = parsed?.evaluator_report ?? null;

    // 用字面量键元组遍历，可直接按维度键索引评分表，无需对评分对象做强转
    const dimensionKeys = ["depth", "structure", "authenticity", "completeness"] as const;
    const avg: Record<(typeof dimensionKeys)[number], number> = {
      depth: 0,
      structure: 0,
      authenticity: 0,
      completeness: 0,
    };
    for (const d of dimensionKeys) {
      const sum = scoreMaps.reduce((acc, s) => acc + s[d], 0);
      avg[d] = Math.round((sum / scoreMaps.length) * 10) / 10;
    }
    const validated = validateGeneratedReport({
      depth: avg.depth,
      structure: avg.structure,
      authenticity: avg.authenticity,
      completeness: avg.completeness,
      jd_match: jdMatch,
      strengths,
      weaknesses,
      suggestions,
      ...(isMining ? { mining_summary: rawMiningSummary } : {}),
    }, isMining);
    if (!validated) {
      return NextResponse.json({ error: "AI 总结结果异常（岗位匹配分须为 0-10 整数，并提供完整总结与所需经历挖掘成果），请重试" }, { status: 502 });
    }

    const evaluatorReport = validateGeneratedEvaluatorReport(rawEvaluatorReport, turns.map((turn) => turn.idx));

    const ts = now();
    // 模型等待期间不持有事务；提交前重新核对场次和全部题目，防止写入过期总结。
    const status = inTransaction(() => {
      if (req.signal.aborted) return 499;
      if (JSON.stringify(interviewQuery.get(interviewId)) !== JSON.stringify(interview) ||
          !resumeMaterial.isCurrent() ||
          JSON.stringify(turnsQuery.all(interviewId)) !== JSON.stringify(allTurns)) return 409;
      db.prepare(
        "UPDATE interviews SET status = 'finished', report = ?, evaluator_report = ?, finished_at = ? WHERE id = ?"
      ).run(JSON.stringify(validated), evaluatorReport ? JSON.stringify(evaluatorReport) : "", ts, interviewId);
      return 200;
    });
    if (status !== 200) {
      return NextResponse.json({ error: status === 499 ? "请求已取消" : "面试状态、背景材料或问答已变更，请刷新后重新生成报告" }, { status });
    }
    return NextResponse.json({
      interview_id: interviewId,
      report: validated,
      evaluator_report: evaluatorReport,
      finished_at: ts,
    });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/[id]/finish", handlePost);
