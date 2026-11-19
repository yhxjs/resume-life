import type {
  HrMindset, MentorAnalysis, NegotiationReport, NegotiationTurnData, SalaryNegotiationDetail,
} from "./salary-negotiation";

export type HistoricalHrMindset = Omit<HrMindset, "looseness"> & { looseness: number | null };
export type HistoricalMentorAnalysis = Omit<MentorAnalysis, "user_argument_score"> & { user_argument_score: number | null };
export type HistoricalNegotiationTurn = Omit<NegotiationTurnData, "hr_mindset" | "mentor_analysis"> & {
  hr_mindset: HistoricalHrMindset;
  mentor_analysis: HistoricalMentorAnalysis;
};
export type HistoricalNegotiationReport = Omit<NegotiationReport, "score" | "persuasion_grade"> & {
  score: number | null;
  persuasion_grade: string | null;
};
export type SalaryNegotiationHistory = Omit<SalaryNegotiationDetail, "turns" | "report" | "hr_style"> & {
  revision: string;
  hr_style: string;
  turns: HistoricalNegotiationTurn[];
  report: HistoricalNegotiationReport | null;
};

export class NegotiationHistoryError extends Error {
  constructor() {
    super("谈薪历史记录结构异常，无法完整读取；原始存档未修改，请恢复有效备份或返回列表。");
    this.name = "NegotiationHistoryError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NegotiationHistoryError();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new NegotiationHistoryError();
  return value;
}
function list(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new NegotiationHistoryError();
  return value;
}
function texts(value: unknown): string[] { return list(value).map((entry) => textRequired(entry)); }
function textRequired(value: unknown): string {
  if (typeof value !== "string") throw new NegotiationHistoryError();
  return value;
}
function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new NegotiationHistoryError();
  return value;
}
function numberOrMissing(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function isHistoricalScore(value: number | null, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
export function isNegotiationHistoryRevision(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** 历史读取只保留实际保存内容，不套用新生成的长度/数量、取整或默认评价。 */
export function readHistoricalMindset(value: unknown): HistoricalHrMindset {
  const raw = record(value);
  return {
    looseness: numberOrMissing(raw.looseness), current_attitude: text(raw.current_attitude),
    estimated_package: text(raw.estimated_package), tactics_label: text(raw.tactics_label), internal_pressure: text(raw.internal_pressure),
  };
}
export function readHistoricalMentor(value: unknown): HistoricalMentorAnalysis {
  const raw = record(value);
  return {
    user_argument_score: numberOrMissing(raw.user_argument_score), strengths: texts(raw.strengths),
    vulnerabilities: texts(raw.vulnerabilities), tactical_tips: text(raw.tactical_tips),
    suggested_replies: list(raw.suggested_replies).map((value) => {
      const reply = record(value);
      return { title: text(reply.title), content: text(reply.content), rationale: text(reply.rationale) };
    }),
  };
}
export function readHistoricalReport(value: unknown, actualTurnNumbers: readonly number[]): HistoricalNegotiationReport | null {
  if (value === null) return null;
  const raw = record(value);
  const allowed = new Set(actualTurnNumbers);
  const seen = new Set<number>();
  return {
    final_package_summary: text(raw.final_package_summary), score: numberOrMissing(raw.score),
    persuasion_grade: raw.persuasion_grade === undefined || raw.persuasion_grade === null ? null : textRequired(raw.persuasion_grade),
    leverage_efficiency: text(raw.leverage_efficiency), mentor_summary: text(raw.mentor_summary),
    real_world_tips: texts(raw.real_world_tips),
    turn_critiques: list(raw.turn_critiques).map((value) => {
      const item = record(value);
      const turnNo = id(item.turn_no);
      if (!allowed.has(turnNo) || seen.has(turnNo) || !["gain", "loss", "neutral"].includes(item.gain_or_loss as string)) throw new NegotiationHistoryError();
      seen.add(turnNo);
      return { turn_no: turnNo, gain_or_loss: item.gain_or_loss as "gain" | "loss" | "neutral", summary: text(item.summary), key_point: text(item.key_point) };
    }),
  };
}

/** 同时用于真实历史 API 与客户端完整响应核对，防止串记录或丢弃坏回合后继续操作。 */
export function readSalaryNegotiationHistory(value: unknown, expectedId: number): SalaryNegotiationHistory {
  const raw = record(value);
  if (id(raw.id) !== expectedId || !isNegotiationHistoryRevision(raw.revision) ||
    !["ongoing", "finished"].includes(raw.status as string) || !Array.isArray(raw.turns)) throw new NegotiationHistoryError();
  const seenIds = new Set<number>();
  let previousTurnNo = 0;
  const turns = raw.turns.map((value): HistoricalNegotiationTurn => {
    const turn = record(value);
    const turnId = id(turn.id);
    const turnNo = id(turn.turn_no);
    if (id(turn.negotiation_id) !== expectedId || seenIds.has(turnId) || turnNo <= previousTurnNo) throw new NegotiationHistoryError();
    seenIds.add(turnId); previousTurnNo = turnNo;
    return {
      id: turnId, negotiation_id: expectedId, turn_no: turnNo,
      user_message: textRequired(turn.user_message), hr_response: textRequired(turn.hr_response), hr_tactics: text(turn.hr_tactics),
      hr_mindset: readHistoricalMindset(turn.hr_mindset), mentor_analysis: readHistoricalMentor(turn.mentor_analysis), created_at: textRequired(turn.created_at),
    };
  });
  return {
    id: expectedId, revision: raw.revision, status: raw.status as "ongoing" | "finished", target_company_tier: textRequired(raw.target_company_tier),
    target_role: textRequired(raw.target_role), expected_salary: textRequired(raw.expected_salary), current_or_competing_offer: text(raw.current_or_competing_offer),
    hr_style: text(raw.hr_style), initial_offer: text(raw.initial_offer), final_package: text(raw.final_package),
    created_at: textRequired(raw.created_at), finished_at: text(raw.finished_at), turns,
    report: readHistoricalReport(raw.report, turns.map((turn) => turn.turn_no)),
  };
}
