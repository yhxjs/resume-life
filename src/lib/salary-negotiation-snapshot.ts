import { createHash } from "node:crypto";
import { dataGeneration, getDb, inTransaction } from "./db";

type RawNegotiation = {
  id: number;
  target_company_tier: string;
  target_role: string;
  expected_salary: string;
  current_or_competing_offer: string;
  hr_style: string;
  status: string;
  initial_offer: string;
  final_package: string;
  report: string;
  created_at: string;
  finished_at: string;
};
type RawNegotiationTurn = {
  id: number;
  negotiation_id: number;
  turn_no: number;
  user_message: string;
  hr_response: string;
  hr_tactics: string;
  hr_mindset: string;
  mentor_analysis: string;
  created_at: string;
};

export function isSalaryNegotiationRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** 版本绑定用户读到的完整原始记录与恢复世代，不用解析/规整后的历史掩盖变化。 */
export function readSalaryNegotiationSnapshot(id: number) {
  return inTransaction(() => {
    const db = getDb();
    const negotiation = db.prepare(`SELECT id, target_company_tier, target_role, expected_salary,
      current_or_competing_offer, hr_style, status, initial_offer, final_package, report, created_at, finished_at
      FROM salary_negotiations WHERE id = ?`).get(id) as RawNegotiation | undefined;
    if (!negotiation) return null;
    const turns = db.prepare(`SELECT id, negotiation_id, turn_no, user_message, hr_response,
      hr_tactics, hr_mindset, mentor_analysis, created_at
      FROM salary_negotiation_turns WHERE negotiation_id = ? ORDER BY turn_no ASC, id ASC`)
      .all(id) as RawNegotiationTurn[];
    const revision = createHash("sha256").update(JSON.stringify([dataGeneration(db), negotiation, turns])).digest("hex");
    return { negotiation, turns, revision };
  });
}

/** 同样可核对包含旧版或损坏 JSON 的原始行，不借历史渲染器改写材料。 */
export function readSalaryNegotiationRevision(id: number): string | null {
  return readSalaryNegotiationSnapshot(id)?.revision ?? null;
}
