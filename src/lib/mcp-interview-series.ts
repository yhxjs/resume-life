import { getDb, inTransaction, now } from "./db";
import { loadResumeContext } from "./resumes";
import { resolveResumeVersionId } from "./resume-versions";
import { interviewStyleOf } from "./interview";
import { seriesRoundOf, SERIES_ROUNDS, validateGeneratedSeriesReport } from "./series";
import { buildSeriesAdvanceMessages, parseSeriesAdvanceQuestion, SERIES_FIRST_PROMPT } from "./interview-series-advance-llm";
import { buildSeriesFinalizeMessages, SERIES_FINALIZE_PROMPT } from "./interview-series-finalize-llm";
import { readSeriesFinalizeRound, type SeriesFinalizeRoundSource } from "./interview-series-finalize-context";
import { loadPriorSeriesContext } from "./interview-commands/series-context";
import { createInterviewSeriesRecord, storeInterviewSeriesReport } from "./interview-series-store";
import { createInterviewSession } from "./interview-session-store";
import { assertMcpContext, mcpContextPage, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpCreateOnce } from "./mcp-state";

export type SeriesSource = { kind: "create"; resumeId: number; versionId: number; jd: string; rounds: number }
  | { kind: "advance"; seriesId: number; fromInterviewId: number }
  | { kind: "finalize"; seriesId: number };
type SeriesRow = { id: number; resume_id: number; resume_version_id: number; jd: string; rounds: number; status: string; final_report: string };

function capture(source: SeriesSource) {
  if (source.kind === "create") {
    resolveResumeVersionId(source.resumeId, source.versionId);
    return { source, roundNo: 1, rules: SERIES_FIRST_PROMPT(interviewStyleOf("deep").persona),
      messages: buildSeriesAdvanceMessages({ roundNo: 1, jd: source.jd, resumeContext: loadResumeContext(source.resumeId, source.versionId), priorParts: [] }) };
  }
  const db = getDb(), series = db.prepare("SELECT id,resume_id,resume_version_id,jd,rounds,status,final_report FROM interview_series WHERE id=?").get(source.seriesId) as SeriesRow | undefined;
  if (!series) throw new McpOperationError("NOT_FOUND", "进阶面试不存在");
  if (series.final_report || series.status !== "ongoing") throw new McpOperationError("CONFLICT", "系列已结束或已有总评，请核对状态");
  const rounds = db.prepare("SELECT id,round_no,style,status,report,evaluator_report FROM interviews WHERE series_id=? ORDER BY round_no,id").all(source.seriesId) as
    (SeriesFinalizeRoundSource & { id: number; status: string })[];
  if (source.kind === "advance") {
    const last = rounds.at(-1);
    if (!last || last.id !== source.fromInterviewId || last.round_no >= SERIES_ROUNDS || last.status !== "finished" || !last.report) {
      throw new McpOperationError("CONFLICT", "须从最新且已有报告的场次推进下一轮");
    }
    if (rounds.length !== last.round_no || rounds.some((round, index) => round.round_no !== index + 1)) throw new McpOperationError("INVALID_ARGUMENT", "系列轮次不完整");
    const roundNo = last.round_no + 1, definition = seriesRoundOf(roundNo)!;
    const prior = loadPriorSeriesContext(series.id, roundNo);
    return { source, series, rounds, roundNo, priorQuestions: [...prior.questions], rules: SERIES_FIRST_PROMPT(interviewStyleOf(definition.style).persona),
      messages: buildSeriesAdvanceMessages({ roundNo, jd: series.jd, resumeContext: loadResumeContext(series.resume_id, series.resume_version_id), priorParts: prior.parts }) };
  }
  if (rounds.length !== SERIES_ROUNDS || rounds.some((row, index) => row.round_no !== index + 1 || row.status !== "finished" || !row.report)) {
    throw new McpOperationError("INVALID_ARGUMENT", "请先完成三轮面试并保存各轮报告");
  }
  const inputs = rounds.map(row => {
    const answered = db.prepare("SELECT idx FROM interview_turns WHERE interview_id=? AND answered_at!='' ORDER BY idx").all(row.id) as { idx: number }[];
    const result = readSeriesFinalizeRound(row, new Set(answered.map(turn => turn.idx)));
    if (!result) throw new McpOperationError("INVALID_ARGUMENT", "本轮报告损坏，请核对原记录");
    return result;
  });
  const overall = Math.round(inputs.reduce((sum, row) => sum + row.scores.overall, 0) / inputs.length * 10) / 10;
  return { source, series, rounds, overall, rules: SERIES_FINALIZE_PROMPT, messages: buildSeriesFinalizeMessages(series.jd, inputs) };
}

export function getInterviewSeriesContext(source: SeriesSource, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(source), page));
}

export function saveInterviewSeriesResult(input: { source: SeriesSource; expectedRevision: string; result: object; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_interview_series_result", idempotencyKey, payload, () => {
    const source = input.source, context = capture(source);
    assertMcpContext(context, input.expectedRevision);
    if (source.kind === "create") {
      const created = createInterviewSeriesRecord({ ...source, question: parseSeriesAdvanceQuestion(JSON.stringify(input.result)), at: now() });
      return { id: created.seriesId };
    }
    const series = context.series!;
    if (source.kind === "advance") {
      const question = parseSeriesAdvanceQuestion(JSON.stringify(input.result), new Set(context.priorQuestions));
      const roundNo = context.roundNo!, style = seriesRoundOf(roundNo)!.style;
      const id = createInterviewSession({ resumeId: series.resume_id, versionId: series.resume_version_id, jd: series.jd, rounds: series.rounds,
        style, seriesId: series.id, roundNo, question, at: now() });
      return { id };
    }
    const report = validateGeneratedSeriesReport(input.result, context.overall!);
    if (!report) throw new McpOperationError("INVALID_ARGUMENT", "总评必须包含四项有效结论文本，且各不超篇幅上限");
    storeInterviewSeriesReport(series.id, series.status, series.final_report, report, now());
    return { id: series.id };
  }, id => !!getDb().prepare(input.source.kind === "advance" ? "SELECT 1 FROM interviews WHERE id=? AND series_id=?" : "SELECT 1 FROM interview_series WHERE id=?")
    .get(...(input.source.kind === "advance" ? [id, input.source.seriesId] : [id])));
}
