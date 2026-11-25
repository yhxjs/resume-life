import { getDb, inTransaction } from "./db";
import { createInterviewSession } from "./interview-session-store";
import type { SeriesReport } from "./series";

export function createInterviewSeriesRecord(input: { resumeId: number; versionId: number; jd: string; rounds: number; question: string; at: string }) {
  return inTransaction(() => {
    const seriesId = Number(getDb().prepare("INSERT INTO interview_series (resume_id,resume_version_id,jd,rounds,created_at) VALUES (?,?,?,?,?)")
      .run(input.resumeId, input.versionId, input.jd, input.rounds, input.at).lastInsertRowid);
    const interviewId = createInterviewSession({ ...input, seriesId, roundNo: 1, style: "deep" });
    return { seriesId, interviewId };
  });
}

export function storeInterviewSeriesReport(id: number, status: string, previousReport: string, report: SeriesReport, at: string) {
  return getDb().prepare("UPDATE interview_series SET status='finished', final_report=?, finished_at=? WHERE id=? AND status=? AND final_report=?")
    .run(JSON.stringify(report), at, id, status, previousReport);
}
