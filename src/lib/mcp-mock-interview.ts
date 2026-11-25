import { getDb, inTransaction, now } from "./db";
import { parseInterviewAnswerDecision, validateInterviewQuestion } from "./model-protocol";
import { readInterviewOriginalScores, ORIGINAL_SCORES_UNAVAILABLE } from "./interview-original-scores";
import { parseInterviewFinishPayload } from "./interview-finish-llm";
import { validateGeneratedEvaluatorReport } from "./scores";
import { captureInterviewResumeContext } from "./interview-resume-context";
import { aggregateInterviewReport, commitInterviewTurn, createInterviewSession, storeInterviewReport } from "./interview-session-store";
import { resolveResumeVersionId } from "./resume-versions";
import { loadResumeContext } from "./resumes";
import { questionComparisonKey } from "./question-normalization";
import { canonicalMcpJson, mcpRevision, mockResumeRevision } from "./mcp-revision";
import { McpOperationError } from "./mcp-errors";
import { mcpCreateOnce } from "./mcp-state";
import { loadPriorSeriesContext } from "./interview-commands/series-context";

const conflict = (message: string) => new McpOperationError("CONFLICT", message);
const sessionExists = (id: number) => !!getDb().prepare("SELECT 1 FROM interviews WHERE id=? AND series_id IS NULL").get(id);

export function startMockInterview(input: { resumeId: number; versionId: number; expectedRevision: string; jd: string; style: string; rounds: number; firstQuestion: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("start_mock_interview", idempotencyKey, payload, () => {
    const { resumeId, versionId, jd, rounds, style } = input;
    resolveResumeVersionId(resumeId, versionId);
    if (mockResumeRevision(resumeId, versionId, loadResumeContext(resumeId, versionId)) !== input.expectedRevision) throw conflict("简历材料已变更，请重新读取固定发布版");
    const question = validateInterviewQuestion(input.firstQuestion);
    return { id: createInterviewSession({ resumeId, versionId, jd, rounds, style, seriesId: null, roundNo: 0, question, at: now() }) };
  }, sessionExists);
}

type MockRow = { id: number; resume_id: number; resume_version_id: number | null; series_id: number | null; round_no: number; jd: string; rounds: number; style: string; status: string; report: string };
type Turn = { id: number; idx: number; kind: string; question: string; answer: string; comment: string; scores: string; answered_at: string };
function snapshot(id: number, seriesId?: number) {
  const db = getDb();
  const row = db.prepare("SELECT id,resume_id,resume_version_id,series_id,round_no,jd,rounds,style,status,report,evaluator_report,reverse_interview,finished_at FROM interviews WHERE id=?").get(id) as MockRow | undefined;
  if (!row) throw new McpOperationError("NOT_FOUND", "面试不存在");
  if (seriesId === undefined ? row.series_id !== null : row.series_id !== seriesId) throw new McpOperationError("INVALID_ARGUMENT", "场次不属于所选单场或系列范围");
  const series = seriesId === undefined ? null : db.prepare("SELECT id,status,final_report,jd,rounds FROM interview_series WHERE id=?").get(seriesId);
  if (seriesId !== undefined && !series) throw new McpOperationError("NOT_FOUND", "进阶面试不存在");
  const turns = db.prepare("SELECT id,idx,kind,question,answer,comment,scores,answered_at FROM interview_turns WHERE interview_id=? ORDER BY idx,id").all(id) as Turn[];
  const context = captureInterviewResumeContext(row.resume_id, row.resume_version_id, "（简历已删除）").text;
  const prior = seriesId === undefined ? null : loadPriorSeriesContext(seriesId, row.round_no);
  const revision = mcpRevision("mock-session", [row, turns, context, ...(seriesId === undefined ? [] : [series, prior?.parts])]);
  const last = turns.at(-1);
  const current = row.status === "ongoing" && last && !last.answered_at ? last : null;
  return { row, turns, revision, current, prior };
}
export function readMockState(id: number, seriesId?: number) {
  return inTransaction(() => {
    const { row, turns, revision, current } = snapshot(id, seriesId);
    return { id, revision, resumeId: row.resume_id, versionId: row.resume_version_id, status: row.status, rounds: row.rounds,
      answered: turns.filter(turn => turn.answered_at).length, currentTurnId: current?.id ?? null, currentIndex: current?.idx ?? null, reportSaved: !!row.report };
  });
}

export function answerMockInterview(input: { interviewId: number; seriesId?: number; turnId: number; expectedRevision: string; answer: string; evaluation: object; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce(input.seriesId === undefined ? "answer_mock_interview" : "answer_series_interview", idempotencyKey, payload, () => {
    const { row, turns, revision, current, prior } = snapshot(input.interviewId, input.seriesId);
    if (revision !== input.expectedRevision || current?.id !== input.turnId || row.report) throw conflict("当前回合已变化或结束，请重新读取面试状态");
    const finished = current.idx >= row.rounds;
    if (finished && "next_question" in input.evaluation && input.evaluation.next_question !== "") throw new McpOperationError("INVALID_ARGUMENT", "末题不能再提交下一题");
    const parsed = parseInterviewAnswerDecision(JSON.stringify(input.evaluation), { finalTurn: finished });
    if (!finished && turns.some(turn => questionComparisonKey(turn.question) === questionComparisonKey(parsed.next_question))) throw new McpOperationError("INVALID_ARGUMENT", "下一题不能与本场已有题目重复");
    if (!finished && prior?.questions.has(questionComparisonKey(parsed.next_question))) throw new McpOperationError("INVALID_ARGUMENT", "下一题不能与系列前轮题目重复");
    const { depth, structure, authenticity, completeness, comment } = parsed;
    commitInterviewTurn({ interviewId: row.id, turn: current, answer: input.answer, scores: { depth, structure, authenticity, completeness }, comment,
      nextKind: parsed.next_kind, nextQuestion: parsed.next_question, finished });
    return { id: current.id };
  }, id => !!getDb().prepare("SELECT 1 FROM interview_turns WHERE id=? AND interview_id=?").get(id, input.interviewId));
}

export function finishMockInterview(input: { interviewId: number; seriesId?: number; expectedRevision: string; report: object; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  // Report subobjects can arrive with different key order after reconnect.
  const reportJson = canonicalMcpJson(input.report);
  return mcpCreateOnce(input.seriesId === undefined ? "finish_mock_interview" : "finish_series_interview", idempotencyKey, { ...payload, report: reportJson }, () => {
    const { row, turns, revision } = snapshot(input.interviewId, input.seriesId);
    if (revision !== input.expectedRevision || row.report) throw conflict("面试或报告已变化，请核对当前状态");
    const answered = turns.filter(turn => turn.answered_at);
    if (!answered.length) throw new McpOperationError("INVALID_ARGUMENT", "至少需要一次原答才能保存报告");
    const originals = answered.map(turn => {
      const scores = readInterviewOriginalScores(turn.scores)?.scores;
      if (!scores) throw new McpOperationError("INVALID_ARGUMENT", ORIGINAL_SCORES_UNAVAILABLE);
      return scores;
    });
    const mining = row.style === "mining", parsed = parseInterviewFinishPayload(reportJson, mining);
    const report = aggregateInterviewReport(parsed, originals, mining);
    if (!report) throw new McpOperationError("INVALID_ARGUMENT", "总结字段、篇幅或岗位匹配分无效");
    const evaluator = validateGeneratedEvaluatorReport(parsed?.evaluator_report, answered.map(turn => turn.idx));
    if (parsed?.evaluator_report !== undefined && !evaluator) throw new McpOperationError("INVALID_ARGUMENT", "录用评估字段或依据题号无效");
    storeInterviewReport(row.id, report, evaluator, now());
    return { id: row.id };
  }, id => input.seriesId === undefined ? sessionExists(id) : !!getDb().prepare("SELECT 1 FROM interviews WHERE id=? AND series_id=?").get(id, input.seriesId));
}
