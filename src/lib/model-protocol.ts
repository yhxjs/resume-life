import type { ScoreMap } from "./scores";
import type { ReverseInterviewEvaluation } from "./interview";
import { INTERVIEW_QUESTION_MAX_CHARS } from "./prompt-guidelines";
import { hasQuestionContent } from "./question-normalization";
import { parseModelJson } from "./model-json";

export class ModelProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

export type DefenseDrillEvaluation = {
  defense_score: number;
  interviewer_roast: string;
  defense_critique: string;
  improved_answer: string;
};

/** 新生成的硬上限独立于提示词建议篇幅；不限制历史读取。 */
export const RESUME_DEFENSE_DRILL_OUTPUT_LIMITS = {
  interviewer_roast: 600,
  defense_critique: 1200,
  improved_answer: 1200,
} as const;

export type InterviewAnswerDecision = ScoreMap & {
  comment: string;
  next_kind: "followup" | "question";
  next_question: string;
};

/** 新生成的逐题反馈上限；独立于历史记录读取与模型的可配置 token 额度。 */
export const INTERVIEW_ANSWER_OUTPUT_LIMITS = {
  comment: 1_200,
  reference: 2_400,
  reverseAnswer: 1_200,
  reverseEvaluationText: 1_200,
} as const;

export const DRILL_EVALUATION_OUTPUT_LIMITS = {
  comment: 1_200,
  reference: 2_400,
} as const;

export type ReverseInterviewResponse = {
  answer: string;
  evaluation: ReverseInterviewEvaluation;
};

function parseObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseModelJson(raw.trim());
  } catch {
    throw new ModelProtocolError(`${label}不是有效 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelProtocolError(`${label}必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

function rejectUnexpectedKeys(parsed: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(parsed).some((key) => !allowed.includes(key))) {
    throw new ModelProtocolError(`${label}包含未声明字段`);
  }
}

function nonEmptyString(
  value: unknown,
  field: string,
  label: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelProtocolError(`${label}字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function nonEmptyContentString(value: unknown, field: string, label: string): string {
  const text = nonEmptyString(value, field, label);
  if (!hasQuestionContent(text)) {
    throw new ModelProtocolError(`${label}字段 ${field} 不能仅含标点或不可见字符`);
  }
  return text;
}

/** Validate and trim a newly generated interview question without changing its content. */
export function validateInterviewQuestion(value: unknown): string {
  const question = nonEmptyString(value, "question", "AI 面试出题");
  if (question.length > INTERVIEW_QUESTION_MAX_CHARS) {
    throw new ModelProtocolError(`AI 面试题不能超过 ${INTERVIEW_QUESTION_MAX_CHARS} 字符，请重试`);
  }
  if (!hasQuestionContent(question)) {
    throw new ModelProtocolError("AI 面试题不能只有标点或不可见字符，请重试");
  }
  return question;
}

export function parseDefenseDrillEvaluation(raw: string): DefenseDrillEvaluation {
  const parsed = parseObject(raw, "AI 防御演练评价");
  if (Object.keys(parsed).some((key) => !["defense_score", "interviewer_roast", "defense_critique", "improved_answer"].includes(key))) {
    throw new ModelProtocolError("AI 防御演练评价包含未声明字段");
  }
  const limits = RESUME_DEFENSE_DRILL_OUTPUT_LIMITS;
  const defenseScore = parsed.defense_score;
  if (
    typeof defenseScore !== "number"
    || !Number.isFinite(defenseScore)
    || defenseScore < 0
    || defenseScore > 100
  ) {
    throw new ModelProtocolError("AI 防御演练评价字段 defense_score 必须是 0 到 100 的有限数值");
  }

  const interviewerRoast = nonEmptyContentString(parsed.interviewer_roast, "interviewer_roast", "AI 防御演练评价");
  const defenseCritique = nonEmptyContentString(parsed.defense_critique, "defense_critique", "AI 防御演练评价");
  const improvedAnswer = nonEmptyContentString(parsed.improved_answer, "improved_answer", "AI 防御演练评价");
  for (const [field, value, max] of [
    ["interviewer_roast", interviewerRoast, limits.interviewer_roast],
    ["defense_critique", defenseCritique, limits.defense_critique],
    ["improved_answer", improvedAnswer, limits.improved_answer],
  ] as const) {
    if (value.length > max) {
      throw new ModelProtocolError(`AI 防御演练评价字段 ${field} 不能超过 ${max} 字符`);
    }
  }

  return {
    defense_score: defenseScore,
    interviewer_roast: interviewerRoast,
    defense_critique: defenseCritique,
    improved_answer: improvedAnswer,
  };
}

function parseInterviewScores(parsed: Record<string, unknown>, label: string): ScoreMap {
  const scores = {} as ScoreMap;
  for (const field of ["depth", "structure", "authenticity", "completeness"] as const) {
    const value = parsed[field];
    if (
      typeof value !== "number"
      || !Number.isFinite(value)
      || !Number.isInteger(value)
      || value < 0
      || value > 10
    ) {
      throw new ModelProtocolError(`${label}字段 ${field} 必须是 0 到 10 的整数`);
    }
    scores[field] = value;
  }
  return scores;
}

export function parseInterviewRetryEvaluation(raw: string): ScoreMap & { comment: string; reference: string } {
  const label = "AI 面试重评";
  const parsed = parseObject(raw, label);
  rejectUnexpectedKeys(parsed, ["depth", "structure", "authenticity", "completeness", "comment", "reference"], label);
  const comment = nonEmptyContentString(parsed.comment, "comment", label);
  const reference = nonEmptyContentString(parsed.reference, "reference", label);
  if (comment.length > INTERVIEW_ANSWER_OUTPUT_LIMITS.comment) {
    throw new ModelProtocolError(`AI 面试重评点评不能超过 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.comment} 字符`);
  }
  if (reference.length > INTERVIEW_ANSWER_OUTPUT_LIMITS.reference) {
    throw new ModelProtocolError(`AI 面试重评参考答案不能超过 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.reference} 字符`);
  }
  return {
    ...parseInterviewScores(parsed, label),
    comment,
    reference,
  };
}

/** finalTurn 由服务端题数决定；模型不能自行结束面试。 */
export function parseInterviewAnswerDecision(raw: string, options: { finalTurn?: boolean } = {}): InterviewAnswerDecision {
  const label = "AI 面试回答决策";
  const parsed = parseObject(raw, label);
  rejectUnexpectedKeys(parsed, ["depth", "structure", "authenticity", "completeness", "comment", "next_kind", "next_question"], label);
  const scores = parseInterviewScores(parsed, label);

  if (parsed.next_kind !== "followup" && parsed.next_kind !== "question") {
    throw new ModelProtocolError('AI 面试回答决策字段 next_kind 必须是 "followup" 或 "question"');
  }

  if (typeof parsed.next_question !== "string") {
    throw new ModelProtocolError("AI 面试回答决策字段 next_question 必须是字符串");
  }

  const comment = nonEmptyContentString(parsed.comment, "comment", "AI 面试回答决策");
  if (comment.length > INTERVIEW_ANSWER_OUTPUT_LIMITS.comment) {
    throw new ModelProtocolError(`AI 面试点评不能超过 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.comment} 字符`);
  }
  return {
    ...scores,
    comment,
    next_kind: options.finalTurn ? "question" : parsed.next_kind,
    next_question: options.finalTurn ? "" : validateInterviewQuestion(parsed.next_question),
  };
}

export function parseInterviewReference(raw: string): string {
  const label = "AI 面试参考答案";
  const parsed = parseObject(raw, label);
  rejectUnexpectedKeys(parsed, ["reference"], label);
  const reference = nonEmptyContentString(parsed.reference, "reference", label);
  if (reference.length > INTERVIEW_ANSWER_OUTPUT_LIMITS.reference) {
    throw new ModelProtocolError(`AI 面试参考答案不能超过 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.reference} 字符`);
  }
  return reference;
}

export function parseReverseInterviewResponse(raw: string): ReverseInterviewResponse {
  const label = "AI 反问评估";
  const parsed = parseObject(raw, label);
  rejectUnexpectedKeys(parsed, ["answer", "evaluation"], label);
  if (!parsed.evaluation || typeof parsed.evaluation !== "object" || Array.isArray(parsed.evaluation)) {
    throw new ModelProtocolError(`${label}字段 evaluation 必须是 JSON 对象`);
  }
  const evaluation = parsed.evaluation as Record<string, unknown>;
  rejectUnexpectedKeys(evaluation, ["score", "insight", "feedback", "suggestions"], `${label} evaluation`);
  const score = evaluation.score;
  if (typeof score !== "number" || !Number.isFinite(score) || !Number.isInteger(score) || score < 1 || score > 10) {
    throw new ModelProtocolError(`${label}字段 score 必须是 1 到 10 的整数`);
  }
  // 评级由有效分数确定；协议外的模型 level 已由上面的字段检查拒绝。
  const level = score >= 9 ? "卓越" : score >= 7 ? "优秀" : score >= 5 ? "良好" : score >= 3 ? "一般" : "有待提升";
  const answer = nonEmptyContentString(parsed.answer, "answer", label);
  const insight = nonEmptyContentString(evaluation.insight, "insight", label);
  const feedback = nonEmptyContentString(evaluation.feedback, "feedback", label);
  const suggestions = nonEmptyContentString(evaluation.suggestions, "suggestions", label);
  for (const [field, value, limit] of [
    ["answer", answer, INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseAnswer],
    ["insight", insight, INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseEvaluationText],
    ["feedback", feedback, INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseEvaluationText],
    ["suggestions", suggestions, INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseEvaluationText],
  ] as const) {
    if (value.length > limit) {
      throw new ModelProtocolError(`${label}字段 ${field} 不能超过 ${limit} 字符`);
    }
  }
  return {
    answer,
    evaluation: {
      score,
      level,
      insight,
      feedback,
      suggestions,
    },
  };
}
