import { getDb } from "./db";

type NegotiationBackground = {
  id: number;
  target_company_tier: string;
  target_role: string;
  expected_salary: string;
  current_or_competing_offer: string;
  initial_offer: string;
  status: string;
};
type ConversationTurn = {
  turn_no: number;
  user_message: string;
  hr_response: string;
  hr_mindset: string;
};
type NegotiationSnapshot = {
  phase: "turn";
  negotiation: NegotiationBackground & { hr_style: string };
  turns: readonly ConversationTurn[];
} | {
  phase: "finalize";
  negotiation: NegotiationBackground & { final_package: string; report: string };
  turns: readonly ConversationTurn[];
};

/** 在保存事务内复核生成依据；旧点评、旧策略及未用于本次生成的内部状态不构成冲突。 */
export function negotiationContextMatches(expected: NegotiationSnapshot): boolean {
  const db = getDb();
  const latest = db.prepare(`SELECT id, target_company_tier, target_role, expected_salary,
    current_or_competing_offer, initial_offer, status, hr_style, final_package, report
    FROM salary_negotiations WHERE id = ?`).get(expected.negotiation.id) as
    (NegotiationBackground & { hr_style: string; final_package: string; report: string }) | undefined;
  if (!latest) return false;
  const fields = ["target_company_tier", "target_role", "expected_salary", "current_or_competing_offer", "initial_offer", "status"] as const;
  if (fields.some((field) => latest[field] !== expected.negotiation[field])) return false;
  if (expected.phase === "turn") {
    if (latest.hr_style !== expected.negotiation.hr_style) return false;
  } else if (latest.final_package !== expected.negotiation.final_package || latest.report !== expected.negotiation.report) {
    return false;
  }
  const turns = db.prepare(`SELECT turn_no, user_message, hr_response, hr_mindset
    FROM salary_negotiation_turns WHERE negotiation_id = ? ORDER BY turn_no ASC`)
    .all(expected.negotiation.id) as ConversationTurn[];
  if (turns.length !== expected.turns.length || turns.some((turn, index) => {
    const original = expected.turns[index]!;
    return turn.turn_no !== original.turn_no || turn.user_message !== original.user_message || turn.hr_response !== original.hr_response;
  })) return false;
  return expected.phase !== "turn" || (turns.at(-1)?.hr_mindset ?? "") === (expected.turns.at(-1)?.hr_mindset ?? "");
}
