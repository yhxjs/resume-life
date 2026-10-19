import type { ScoreMap } from "./scores";
import type { ReverseInterviewEvaluation } from "./interview";

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

export type InterviewAnswerDecision = ScoreMap & {
  comment: string;
  next_kind: "followup" | "question";
  next_question: string;
};

export type ReverseInterviewResponse = {
  answer: string;
  evaluation: ReverseInterviewEvaluation;
};

function parseObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch {
    throw new ModelProtocolError(`${label}不是有效 JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelProtocolError(`${label}必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
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

export function parseDefenseDrillEvaluation(raw: string): DefenseDrillEvaluation {
  const parsed = parseObject(raw, "AI 防御演练评价");
  const defenseScore = parsed.defense_score;
  if (
    typeof defenseScore !== "number"
    || !Number.isFinite(defenseScore)
    || defenseScore < 0
    || defenseScore > 100
  ) {
    throw new ModelProtocolError("AI 防御演练评价字段 defense_score 必须是 0 到 100 的有限数值");
  }

  return {
    defense_score: defenseScore,
    interviewer_roast: nonEmptyString(parsed.interviewer_roast, "interviewer_roast", "AI 防御演练评价"),
    defense_critique: nonEmptyString(parsed.defense_critique, "defense_critique", "AI 防御演练评价"),
    improved_answer: nonEmptyString(parsed.improved_answer, "improved_answer", "AI 防御演练评价"),
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
  return {
    ...parseInterviewScores(parsed, label),
    comment: nonEmptyString(parsed.comment, "comment", label),
    reference: nonEmptyString(parsed.reference, "reference", label),
  };
}

export function parseInterviewAnswerDecision(raw: string): InterviewAnswerDecision {
  const parsed = parseObject(raw, "AI 面试回答决策");
  const scores = parseInterviewScores(parsed, "AI 面试回答决策");

  if (parsed.next_kind !== "followup" && parsed.next_kind !== "question") {
    throw new ModelProtocolError('AI 面试回答决策字段 next_kind 必须是 "followup" 或 "question"');
  }

  return {
    ...scores,
    comment: nonEmptyString(parsed.comment, "comment", "AI 面试回答决策"),
    next_kind: parsed.next_kind,
    next_question: nonEmptyString(parsed.next_question, "next_question", "AI 面试回答决策"),
  };
}

export function parseInterviewReference(raw: string): string {
  const parsed = parseObject(raw, "AI 面试参考答案");
  return nonEmptyString(parsed.reference, "reference", "AI 面试参考答案");
}

export function parseReverseInterviewResponse(raw: string): ReverseInterviewResponse {
  const label = "AI 反问评估";
  const parsed = parseObject(raw, label);
  if (!parsed.evaluation || typeof parsed.evaluation !== "object" || Array.isArray(parsed.evaluation)) {
    throw new ModelProtocolError(`${label}字段 evaluation 必须是 JSON 对象`);
  }
  const evaluation = parsed.evaluation as Record<string, unknown>;
  const score = evaluation.score;
  if (typeof score !== "number" || !Number.isFinite(score) || !Number.isInteger(score) || score < 1 || score > 10) {
    throw new ModelProtocolError(`${label}字段 score 必须是 1 到 10 的整数`);
  }
  if (!["卓越", "优秀", "良好", "一般", "有待提升"].includes(evaluation.level as string)) {
    throw new ModelProtocolError(`${label}字段 level 必须是有效评级`);
  }
  return {
    answer: nonEmptyString(parsed.answer, "answer", label),
    evaluation: {
      score,
      level: evaluation.level as string,
      insight: nonEmptyString(evaluation.insight, "insight", label),
      feedback: nonEmptyString(evaluation.feedback, "feedback", label),
      suggestions: nonEmptyString(evaluation.suggestions, "suggestions", label),
    },
  };
}
