import type { InterviewData } from "@/hooks/interview-types";
import { DIMENSIONS } from "@/lib/scores";
import { normalizeInterviewRetryHistory } from "@/lib/interview-retry-history";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown) => text(value) && Boolean(value.trim());
const positiveId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const score = (value: unknown, min = 0) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= 10;
const texts = (value: unknown) => Array.isArray(value) && value.every(text);
const scores = (value: unknown) => record(value) && DIMENSIONS.every(({ key }) => score(value[key]));
const status = (value: unknown) => value === "ongoing" || value === "finished";

export function isInterviewReport(value: unknown): boolean {
  if (!record(value) || !scores(value) || !score(value.jd_match) || !score(value.overall) ||
      ![value.strengths, value.weaknesses, value.suggestions].every(nonempty)) return false;
  if (value.mining_summary === undefined) return true;
  const mining = value.mining_summary;
  return record(mining) && ["project_name", "background", "actions", "tradeoffs", "results", "contribution"].every(key => text(mining[key])) &&
    texts(mining.resume_bullets) && Array.isArray(mining.pending_confirmations) && mining.pending_confirmations.every(item =>
      record(item) && [item.category, item.item, item.source_hint].every(text));
}

/** 历史报告回读允许曾被保留的有限数值题号；新生成报告由 validateGeneratedEvaluatorReport 严格校验。 */
export function isInterviewEvaluatorReport(value: unknown): boolean {
  if (!record(value) || !text(value.recommendation) || !["Strong Hire", "Hire", "Lean No", "No Hire"].includes(value.recommendation) ||
      ![value.level, value.level_justification, value.summary_for_hr, value.placement_suggestion].every(nonempty) ||
      !texts(value.hire_reasons) || !texts(value.concerns_and_risks)) return false;
  return value.evidence_quotes === undefined || (Array.isArray(value.evidence_quotes) && value.evidence_quotes.every(item =>
    record(item) && typeof item.turn_idx === "number" && Number.isFinite(item.turn_idx) && text(item.topic) && text(item.observation)));
}

export function isInterviewReverseResult(value: unknown): boolean {
  if (!record(value) || ![value.question, value.answer, value.created_at].every(text) || !record(value.evaluation)) return false;
  const evaluation = value.evaluation;
  return score(evaluation.score, 1) && [evaluation.level, evaluation.insight, evaluation.feedback, evaluation.suggestions].every(text);
}

/** 校验网络详情而非新生成内容：不截长文、不重算分数、不裁剪正文，所有回读共用此边界。 */
export function parseInterviewDetail(value: unknown, expectedId: number): InterviewData {
  const invalid = () => new Error("服务器返回的面试状态不完整或与当前面试不符");
  if (!record(value) || !positiveId(value.id) || value.id !== expectedId ||
      ![value.resume_title, value.jd, value.style, value.created_at, value.finished_at].every(text) ||
      !positiveId(value.rounds) || !(positiveId(value.round_no) || (value.series_id === null && value.round_no === 0)) || !status(value.status) ||
      !(value.series_id === null || positiveId(value.series_id)) || !(value.series_status === null || text(value.series_status)) ||
      !Array.isArray(value.series_rounds) || !Array.isArray(value.turns) ||
      !(value.report === null || isInterviewReport(value.report)) || !(value.evaluator_report === null || isInterviewEvaluatorReport(value.evaluator_report)) ||
      !(value.reverse_interview === null || isInterviewReverseResult(value.reverse_interview))) throw invalid();
  for (const key of ["resume_id", "resume_version_id", "resume_version"]) {
    if (value[key] !== undefined && value[key] !== null && !positiveId(value[key])) throw invalid();
  }
  if (value.resume_version_name !== undefined && value.resume_version_name !== null && !text(value.resume_version_name)) throw invalid();
  const roundIds = new Set<unknown>();
  const roundNumbers = new Set<unknown>();
  for (const round of value.series_rounds) {
    if (!record(round) || !positiveId(round.id) || !positiveId(round.round_no) || !status(round.status) ||
        !(round.overall === null || score(round.overall)) || roundIds.has(round.id) || roundNumbers.has(round.round_no)) throw invalid();
    roundIds.add(round.id); roundNumbers.add(round.round_no);
  }
  const turnIds = new Set<unknown>();
  const turnIndexes = new Set<unknown>();
  const turns = value.turns.map(turn => {
    if (!record(turn) || !positiveId(turn.id) || !positiveId(turn.idx) || turnIds.has(turn.id) || turnIndexes.has(turn.idx) ||
        ![turn.kind, turn.question, turn.answer, turn.comment, turn.reference, turn.answered_at].every(text) ||
        !(turn.scores === null || scores(turn.scores)) ||
        (turn.scores_error !== undefined && (!nonempty(turn.scores_error) || turn.scores !== null)) ||
        !(turn.notebook_id === null || positiveId(turn.notebook_id))) throw invalid();
    const retries = normalizeInterviewRetryHistory(turn.retries);
    if (retries === null || (turn.retries_error !== undefined && (!nonempty(turn.retries_error) || retries.length > 0))) throw invalid();
    turnIds.add(turn.id); turnIndexes.add(turn.idx);
    return { ...turn, retries };
  });
  return { ...value, turns,
    evaluator_report: record(value.evaluator_report) ? { ...value.evaluator_report, evidence_quotes: value.evaluator_report.evidence_quotes ?? [] } : null,
  } as InterviewData;
}
