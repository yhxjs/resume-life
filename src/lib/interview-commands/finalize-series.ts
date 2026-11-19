import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { readSeriesFinalizeRound, type SeriesFinalizeRoundSource } from "@/lib/interview-series-finalize-context";
import { normalizeSeriesReport, validateGeneratedSeriesReport, SERIES_REPORT_TEXT_LIMIT, SERIES_ROUNDS, type SeriesReport } from "@/lib/series";
import { InterviewCommandError } from "./errors";
import { errorMessage } from "@/lib/error-message";
import { buildSeriesFinalizeMessages, SERIES_FINALIZE_PROMPT } from "@/lib/interview-series-finalize-llm";

type StoredRound = SeriesFinalizeRoundSource & { id: number };

export async function finalizeSeries(seriesId: number, signal: AbortSignal): Promise<{ report: SeriesReport; finished_at: string }> {
  const db = getDb();
  const seriesQuery = db.prepare("SELECT id, jd, status, final_report FROM interview_series WHERE id = ?");
  const series = seriesQuery.get(seriesId) as
    | { id: number; jd: string; status: string; final_report: string }
    | undefined;
  if (!series) throw new InterviewCommandError("进阶面试不存在", 404);
  let existing: SeriesReport | null = null;
  try { existing = normalizeSeriesReport(JSON.parse(series.final_report)); }
  catch { /* 缺失或损坏的历史总评可重新生成，成功前保留原记录。 */ }
  if (existing) throw new InterviewCommandError("总评已生成", 400);
  if (series.status !== "ongoing" && series.status !== "finished") throw new InterviewCommandError("进阶面试状态已变更，请刷新后重试", 409);

  const roundsQuery = db.prepare("SELECT id, round_no, style, report, evaluator_report FROM interviews WHERE series_id = ? AND report != '' ORDER BY round_no");
  const rounds = roundsQuery.all(seriesId) as StoredRound[];
  const answeredIndexesQuery = db.prepare("SELECT idx FROM interview_turns WHERE interview_id = ? AND answered_at != '' ORDER BY idx");
  const readAnsweredIndexes = (interviewId: number) =>
    (answeredIndexesQuery.all(interviewId) as { idx: number }[]).map((turn) => turn.idx);
  const answeredIndexes = rounds.map((row) => readAnsweredIndexes(row.id));
  const roundInputs = rounds.map((row, index) => {
    const input = readSeriesFinalizeRound(row, new Set(answeredIndexes[index]!));
    if (!input) throw new InterviewCommandError("该轮报告数据异常，请重新生成该轮报告", 400);
    return input;
  });
  if (
    roundInputs.length !== SERIES_ROUNDS
    || roundInputs.some((item, index) => item.round_no !== index + 1)
  ) {
    throw new InterviewCommandError("三轮报告必须恰好包含第 1 至第 3 轮，请检查轮次数据后重试", 400);
  }

  const overall = Math.round((roundInputs.reduce((sum, item) => sum + item.scores.overall, 0) / roundInputs.length) * 10) / 10;

  const release = acquireCommandLock(`interview-series:${seriesId}`);
  if (!release) throw new InterviewCommandError("正在生成跨轮总评，请稍后重试", 409);
  try {
    let raw: string;
    try {
      checkModelField(series.jd, "岗位要求（JD）");
      raw = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.seriesFinalize, entity: { type: "interview_series", id: seriesId } },
        SERIES_FINALIZE_PROMPT,
        buildSeriesFinalizeMessages(series.jd, roundInputs),
        { signal, requireJson: "strict" },
      );
    } catch (error) {
      const status = error instanceof ModelInputBudgetError ? 413 : 502;
      const message = error instanceof LlmConfigError ? error.message : errorMessage(error);
      throw new InterviewCommandError(message, status);
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (error) {
      throw new InterviewCommandError(`AI 总评结果异常：${errorMessage(error)}`, 502);
    }
    const report = validateGeneratedSeriesReport(parsed, overall);
    if (!report) {
      throw new InterviewCommandError(`AI 总评结果异常：综合结论、强项、短板和建议须为非空文本，且各不超过 ${SERIES_REPORT_TEXT_LIMIT} 字符，请重试`, 502);
    }

    signal.throwIfAborted();
    const ts = now();
    const committed = inTransaction(() => {
      // BEGIN IMMEDIATE 内复读相同查询，比较报告与引用资格；未发给模型的原答、旧评分不参与比较。
      if (JSON.stringify(seriesQuery.get(seriesId)) !== JSON.stringify(series) ||
          JSON.stringify(roundsQuery.all(seriesId)) !== JSON.stringify(rounds) ||
          JSON.stringify(rounds.map((row) => readAnsweredIndexes(row.id))) !== JSON.stringify(answeredIndexes)) return null;
      return db.prepare(`
        UPDATE interview_series SET status = 'finished', final_report = ?, finished_at = ?
        WHERE id = ? AND status = ? AND final_report = ?
      `).run(JSON.stringify(report), ts, seriesId, series.status, series.final_report);
    });
    if (committed?.changes !== 1) throw new InterviewCommandError("进阶面试资料、状态或三轮报告已变更，请刷新后重试", 409);
    return { report, finished_at: ts };
  } finally {
    release();
  }
}
