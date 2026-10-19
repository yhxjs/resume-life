import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { normalizeReport, normalizeEvaluatorReport, type InterviewReport, type EvaluatorReport } from "@/lib/scores";

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const interviewId = Number(id);
  if (!Number.isInteger(interviewId)) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }
  const db = getDb();
  const interview = db
    .prepare(
      "SELECT i.id, i.resume_id, i.resume_version_id, i.jd, i.rounds, i.style, i.series_id, i.round_no, i.status, i.report, i.evaluator_report, i.reverse_interview, i.created_at, i.finished_at, COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, rv.version AS resume_version, rv.name AS resume_version_name FROM interviews i JOIN resumes r ON r.id = i.resume_id LEFT JOIN resume_versions rv ON rv.id = i.resume_version_id WHERE i.id = ?"
    )
    .get(interviewId) as
    | {
        id: number;
        resume_id: number; resume_version_id: number | null;
        jd: string;
        rounds: number;
        style: string;
        series_id: number | null;
        round_no: number;
        status: string;
        report: string;
        evaluator_report: string;
        reverse_interview: string;
        created_at: string;
        finished_at: string;
        resume_title: string;
      }
    | undefined;
  if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });

  // 进阶面试：附上系列状态与各轮概览（含总分），供详情页步进条展示
  let seriesStatus: string | null = null;
  let seriesRounds: { id: number; round_no: number; status: string; overall: number | null }[] = [];
  if (interview.series_id) {
    const series = db.prepare("SELECT status FROM interview_series WHERE id = ?").get(interview.series_id) as
      | { status: string }
      | undefined;
    seriesStatus = series?.status ?? null;
    const siblings = db
      .prepare("SELECT id, round_no, status, report FROM interviews WHERE series_id = ? ORDER BY round_no")
      .all(interview.series_id) as { id: number; round_no: number; status: string; report: string }[];
    seriesRounds = siblings.map((s) => {
      let overall: number | null = null;
      if (s.report) {
        try {
          const value: unknown = JSON.parse(s.report).overall;
          const score = typeof value === "number" ? value : NaN;
          overall = Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
        } catch {
          overall = null;
        }
      }
      return { id: s.id, round_no: s.round_no, status: s.status, overall };
    });
  }

  const turns = db
    .prepare(
      `SELECT t.id, t.idx, t.kind, t.question, t.answer, t.comment, t.scores, t.reference, t.retries, t.answered_at,
              ne.id AS notebook_id
       FROM interview_turns t
       LEFT JOIN notebook_entries ne ON ne.source = 'interview' AND ne.source_id = t.id
       WHERE t.interview_id = ?
       ORDER BY t.idx`
    )
    .all(interviewId) as {
    id: number;
    idx: number;
    kind: string;
    question: string;
    answer: string;
    comment: string;
    scores: string;
    reference: string;
    retries: string;
    answered_at: string;
    notebook_id: number | null;
  }[];

  let report: InterviewReport | null = null;
  if (interview.report) {
    try {
      report = normalizeReport(JSON.parse(interview.report));
    } catch {
      report = null;
    }
  }

  let evaluatorReport: EvaluatorReport | null = null;
  if (interview.evaluator_report) {
    try {
      evaluatorReport = normalizeEvaluatorReport(JSON.parse(interview.evaluator_report));
    } catch {
      evaluatorReport = null;
    }
  }

  let reverseInterview = null;
  if (interview.reverse_interview) {
    try {
      reverseInterview = JSON.parse(interview.reverse_interview);
    } catch {
      reverseInterview = null;
    }
  }

  return NextResponse.json({
    ...interview,
    series_status: seriesStatus,
    series_rounds: seriesRounds,
    report,
    evaluator_report: evaluatorReport,
    reverse_interview: reverseInterview,
    turns: turns.map((t) => {
      let scores = null;
      try {
        scores = JSON.parse(t.scores || "null");
      } catch {
        scores = null;
      }
      let retries = [];
      try {
        retries = JSON.parse(t.retries || "[]");
      } catch {
        retries = [];
      }
      return { ...t, reference: t.reference || "", retries, scores };
    }),
  });
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const interviewId = Number(id);
  if (!Number.isInteger(interviewId)) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => {
    clearEntityLlmLabels(db, "interview", interviewId);
    return db.prepare("DELETE FROM interviews WHERE id = ?").run(interviewId);
  });
  if (result.changes === 0) return NextResponse.json({ error: "面试不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withRouteErrorHandling("DELETE /api/interviews/[id]", handleDelete);
export const GET = withRouteErrorHandling("GET /api/interviews/[id]", handleGet);
