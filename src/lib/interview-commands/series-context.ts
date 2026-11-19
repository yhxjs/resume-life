import { getDb } from "@/lib/db";
import { buildPriorSeriesContext, type PriorSeriesRound, type PriorSeriesQuestion } from "@/lib/interview-series-context";

/** 消息与去重集合共用同一份前轮原题，不把前轮分数带入本轮逐题评分。 */
export function loadPriorSeriesContext(seriesId: number, beforeRound: number) {
  const db = getDb();
  const rounds = db.prepare(
    "SELECT round_no, style, report FROM interviews WHERE series_id = ? AND round_no < ? ORDER BY round_no"
  ).all(seriesId, beforeRound) as PriorSeriesRound[];
  const questions = db.prepare(`SELECT i.round_no, t.idx, t.kind, t.question
    FROM interview_turns t JOIN interviews i ON i.id = t.interview_id
    WHERE i.series_id = ? AND i.round_no < ? ORDER BY i.round_no, t.idx`)
    .all(seriesId, beforeRound) as PriorSeriesQuestion[];
  return buildPriorSeriesContext(rounds, questions);
}
