import { describe, expect, it } from "vitest";
import { readSalaryNegotiationHistory } from "../salary-negotiation-history";
import { hasNewSavedNegotiationTurn, readNegotiationFinalizeResponse, readNegotiationTurnResponse } from "../salary-negotiation-response";

const revision = "a".repeat(64);
const nextRevision = "b".repeat(64);
const message = "请确认保证薪数，奖金尚未达成一致。";
function turn(no: number, userMessage: string) {
  return { id: no, negotiation_id: 1, turn_no: no, user_message: userMessage,
    hr_response: "模拟回应：保证薪数仍需确认。", hr_tactics: "澄清",
    hr_mindset: { looseness: 20, current_attitude: "核对中", estimated_package: "尚未确定", tactics_label: "核实", internal_pressure: "预算待审批" },
    mentor_analysis: { user_argument_score: 7, strengths: ["明确区分条件"], vulnerabilities: ["薪数待确认"], tactical_tips: "请求书面核实",
      suggested_replies: [{ title: "核实", content: "请确认保证薪数。", rationale: "保留未知条件" }] }, created_at: "saved-time" };
}
function history() {
  return readSalaryNegotiationHistory({ id: 1, revision, target_company_tier: "custom", target_role: "工程师", expected_salary: "30k",
    current_or_competing_offer: "无", hr_style: "standard", status: "ongoing", initial_offer: "模拟开价", final_package: "", report: null,
    created_at: "original", finished_at: "", turns: [turn(1, "")] }, 1);
}
function response(kind: "turn" | "finalize") {
  return kind === "turn" ? { ...turn(2, message), base_revision: revision, revision: nextRevision }
    : { id: 1, status: "finished", final_package: "尚未达成", finished_at: "saved-finish", report: {}, base_revision: revision, revision: nextRevision };
}

describe.each(["turn", "finalize"] as const)("%s 完成回包的存档版本", kind => {
  const read = (raw: unknown, before = history()) => kind === "turn"
    ? readNegotiationTurnResponse(raw, before, message)
    : readNegotiationFinalizeResponse(raw, before);

  it("基于已读版本合并结果并保存新版本，原历史不变", () => {
    const before = history();
    const original = structuredClone(before);
    const saved = read(response(kind), before);
    expect(saved.revision).toBe(nextRevision);
    expect(before).toEqual(original);
    if (kind === "turn") expect(saved.turns.map(item => item.user_message)).toEqual(["", message]);
    else expect(saved).toMatchObject({ status: "finished", final_package: "尚未达成", finished_at: "saved-finish" });
  });

  it.each([
    { base_revision: undefined }, { base_revision: null }, { base_revision: nextRevision },
    { base_revision: "A".repeat(64) }, { base_revision: "a".repeat(63) },
    { revision: undefined }, { revision: null }, { revision },
    { revision: "B".repeat(64) }, { revision: "b".repeat(63) }, { revision: "g".repeat(64) },
  ])("拒绝缺失、伪造或未推进的版本 %#", patch => {
    expect(() => read({ ...response(kind), ...patch })).toThrow();
  });
});

describe("谈薪新增存档恢复的版本变化", () => {
  it("版本推进不妨碍识别新增同文回合，背景或旧回合变化仍不能认领", () => {
    const before = history();
    const saved = readSalaryNegotiationHistory({ ...before, revision: nextRevision, turns: [...before.turns, turn(2, message)] }, 1);
    expect(hasNewSavedNegotiationTurn(before, saved, message)).toBe(true);
    expect(hasNewSavedNegotiationTurn(before, { ...saved, initial_offer: "新的报价" }, message)).toBe(false);
    expect(hasNewSavedNegotiationTurn(before, { ...saved, turns: [{ ...saved.turns[0]!, hr_response: "更改的旧报价" }, saved.turns[1]!] }, message)).toBe(false);
    expect(hasNewSavedNegotiationTurn(before, before, message)).toBe(false);
  });
});
