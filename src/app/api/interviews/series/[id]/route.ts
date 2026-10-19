import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { normalizeReport, type InterviewReport } from "@/lib/scores";
import { normalizeSeriesReport, SERIES_ROUNDS, type SeriesReport } from "@/lib/series";

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const seriesId = Number(id);
  if (!Number.isInteger(seriesId)) {
    return NextResponse.json({ error: "无效的进阶面试 ID" }, { status: 400 });
  }
  const db = getDb();
  const series = db
    .prepare(
      "SELECT s.id, s.resume_id, s.resume_version_id, s.jd, s.rounds, s.status, s.final_report, s.created_at, s.finished_at, COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, rv.version AS resume_version, rv.name AS resume_version_name FROM interview_series s JOIN resumes r ON r.id = s.resume_id LEFT JOIN resume_versions rv ON rv.id = s.resume_version_id WHERE s.id = ?"
    )
    .get(seriesId) as
    | {
        id: number;
        resume_id: number; resume_version_id: number | null;
        jd: string;
        rounds: number;
        status: string;
        final_report: string;
        created_at: string;
        finished_at: string;
        resume_title: string;
        resume_version: number | null;
        resume_version_name: string | null;
      }
    | undefined;
  if (!series) return NextResponse.json({ error: "进阶面试不存在" }, { status: 404 });

  const interviews = db
    .prepare(
      `SELECT i.id, i.round_no, i.style, i.status, i.rounds, i.report,
              (SELECT COUNT(*) FROM interview_turns t WHERE t.interview_id = i.id AND t.answered_at != '') AS answered
       FROM interviews i WHERE i.series_id = ? ORDER BY i.round_no`
    )
    .all(seriesId) as {
    id: number;
    round_no: number;
    style: string;
    status: string;
    rounds: number;
    report: string;
    answered: number;
  }[];

  let finalReport: SeriesReport | null = null;
  if (series.final_report) {
    try {
      finalReport = normalizeSeriesReport(JSON.parse(series.final_report));
    } catch {
      finalReport = null;
    }
  }

  return NextResponse.json({
    id: series.id,
    resume_id: series.resume_id,
    resume_version_id: series.resume_version_id,
    resume_version: series.resume_version,
    resume_version_name: series.resume_version_name,
    resume_title: series.resume_title,
    jd: series.jd,
    rounds: series.rounds,
    rounds_total: SERIES_ROUNDS,
    status: series.status,
    created_at: series.created_at,
    finished_at: series.finished_at,
    final_report: finalReport,
    entries: interviews.map((it) => {
      let report: InterviewReport | null = null;
      if (it.report) {
        try {
          report = normalizeReport(JSON.parse(it.report));
        } catch {
          report = null;
        }
      }
      return {
        interview_id: it.id,
        round_no: it.round_no,
        style: it.style,
        status: it.status,
        rounds: it.rounds,
        answered: it.answered,
        report,
      };
    }),
  });
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const seriesId = Number(id);
  if (!Number.isInteger(seriesId)) {
    return NextResponse.json({ error: "无效的进阶面试 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => {
    clearEntityLlmLabels(db, "interview_series", seriesId);
    return db.prepare("DELETE FROM interview_series WHERE id = ?").run(seriesId);
  });
  if (result.changes === 0) return NextResponse.json({ error: "进阶面试不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withRouteErrorHandling("DELETE /api/interviews/series/[id]", handleDelete);
export const GET = withRouteErrorHandling("GET /api/interviews/series/[id]", handleGet);
