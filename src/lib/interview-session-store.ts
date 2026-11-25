import { getDb, inTransaction, now } from "./db";
import { syncNotebookSnapshot } from "./notebook";
import { InterviewCommandError } from "./interview-commands/errors";
import { validateGeneratedReport, type EvaluatorReport, type InterviewReport, type ScoreMap } from "./scores";
import type { InterviewFinishPayload } from "./interview-finish-llm";

export function createInterviewSession(input: { resumeId: number; versionId: number; jd: string; rounds: number; style: string; seriesId: number | null; roundNo: number; question: string; at: string }) {
  if (!input.jd.trim()) throw new InterviewCommandError("岗位要求（JD）不能为空", 400);
  return inTransaction(() => {
    const db = getDb();
    const id = Number(db.prepare("INSERT INTO interviews (resume_id,resume_version_id,jd,rounds,style,series_id,round_no,status,created_at) VALUES (?,?,?,?,?,?,?,'ongoing',?)")
      .run(input.resumeId, input.versionId, input.jd, input.rounds, input.style, input.seriesId, input.roundNo, input.at).lastInsertRowid);
    db.prepare("INSERT INTO interview_turns (interview_id,idx,kind,question) VALUES (?,1,'question',?)").run(id, input.question);
    return id;
  });
}

/** Callers revalidate the snapshot inside the same transaction. Only the last unanswered turn can advance. */
export function commitInterviewTurn(input: { interviewId: number; turn: { id: number; idx: number; question: string }; answer: string;
  scores: ScoreMap; comment: string; finished: boolean; nextKind: string; nextQuestion: string }) {
  if (!input.answer.trim()) throw new InterviewCommandError("回答内容不能为空", 400);
  return inTransaction(() => {
    const db = getDb(), { interviewId, turn, answer, comment } = input, scores = JSON.stringify(input.scores);
    const updated = db.prepare(`UPDATE interview_turns SET answer = ?, comment = ?, scores = ?, answered_at = ?
      WHERE id = ? AND interview_id = ? AND answered_at = '' AND question = ?
        AND EXISTS (SELECT 1 FROM interviews WHERE id = ? AND status = 'ongoing')
        AND NOT EXISTS (SELECT 1 FROM interview_turns WHERE interview_id = ? AND idx > ?)`)
      .run(answer, comment, scores, now(), turn.id, interviewId, turn.question, interviewId, interviewId, turn.idx);
    if (updated.changes !== 1) throw new InterviewCommandError("面试资料、当前题目或上下文已变化，请重新读取面试状态后再提交", 409);
    syncNotebookSnapshot(db, "interview", turn.id, { answer, comment, scores });
    if (input.finished) db.prepare("UPDATE interviews SET status = 'finished', finished_at = ? WHERE id = ?").run(now(), interviewId);
    else db.prepare("INSERT INTO interview_turns (interview_id, idx, kind, question) VALUES (?, ?, ?, ?)").run(interviewId, turn.idx + 1, input.nextKind, input.nextQuestion);
  });
}

export function aggregateInterviewReport(payload: InterviewFinishPayload | null, originals: ScoreMap[], isMining: boolean) {
  if (!payload || !originals.length) return null;
  const average = (key: keyof ScoreMap) => Math.round(originals.reduce((sum, scores) => sum + scores[key], 0) / originals.length * 10) / 10;
  return validateGeneratedReport({ depth: average("depth"), structure: average("structure"), authenticity: average("authenticity"), completeness: average("completeness"),
    jd_match: payload.jd_match, strengths: payload.strengths, weaknesses: payload.weaknesses, suggestions: payload.suggestions,
    ...(isMining ? { mining_summary: payload.mining_summary } : {}) }, isMining);
}

export function storeInterviewReport(id: number, report: InterviewReport, evaluator: EvaluatorReport | null, at: string) {
  getDb().prepare("UPDATE interviews SET status = 'finished', report = ?, evaluator_report = ?, finished_at = ? WHERE id = ?")
    .run(JSON.stringify(report), evaluator ? JSON.stringify(evaluator) : "", at, id);
}
