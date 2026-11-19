import { describe, expect, it } from "vitest";
import { NegotiationHistoryError, readHistoricalMentor, readHistoricalMindset, readHistoricalReport, readSalaryNegotiationHistory } from "../salary-negotiation-history";

const turn = { id: 2, negotiation_id: 1, turn_no: 2, user_message: "已提交原话 <T> &amp;\n尚未接受", hr_response: "模拟回应，需审批", hr_tactics: "核对条件",
  hr_mindset: {}, mentor_analysis: {}, created_at: "2026-10-29" };
const base = { id: 1, revision: "a".repeat(64), target_company_tier: "custom", target_role: "工程师", expected_salary: "30k", current_or_competing_offer: "",
  hr_style: "legacy-style", status: "ongoing", initial_offer: "模拟方案", final_package: "", report: null, created_at: "2026-10-29", finished_at: "", turns: [turn] };

describe("谈薪历史的无损读取协议", () => {
  it.each([undefined, null, 1, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64)])("拒绝缺失或非法存档版本 %j", revision => {
    expect(() => readSalaryNegotiationHistory({ ...base, revision }, 1)).toThrow(NegotiationHistoryError);
  });
  it("完整保留存档版本，不重算历史文本对应的令牌", () => {
    const revision = "0123456789abcdef".repeat(4);
    expect(readSalaryNegotiationHistory({ ...base, revision }, 1)).toMatchObject({ revision });
  });
  it("空对象只表示缺失材料，不生成默认评价、建议或分数", () => {
    expect(readHistoricalMindset({})).toEqual({ looseness: null, current_attitude: "", estimated_package: "", tactics_label: "", internal_pressure: "" });
    expect(readHistoricalMentor({})).toEqual({ user_argument_score: null, strengths: [], vulnerabilities: [], tactical_tips: "", suggested_replies: [] });
    expect(readHistoricalReport({}, [])).toEqual({ final_package_summary: "", score: null, persuasion_grade: null, leverage_efficiency: "", mentor_summary: "", turn_critiques: [], real_world_tips: [] });
  });
  it.each([undefined, null, true, false, "75", [], {}, Infinity, NaN])("评分 %j 不转成数字或默认分", (score) => {
    expect(readHistoricalMindset({ looseness: score }).looseness).toBeNull();
    expect(readHistoricalMentor({ user_argument_score: score }).user_argument_score).toBeNull();
    expect(readHistoricalReport({ score }, [])!.score).toBeNull();
  });
  it.each([0, 7.5, 70.5, -1, 101])("数字 %s 完整保留，不取整或夹到范围内", (score) => {
    expect(readHistoricalMindset({ looseness: score }).looseness).toBe(score);
    expect(readHistoricalMentor({ user_argument_score: score }).user_argument_score).toBe(score);
    expect(readHistoricalReport({ score }, [])!.score).toBe(score);
  });
  it("不按新生成的长度和数量限制裁切历史文本，也不改空数组", () => {
    const long = " \n" + "完整记录 <T> &amp;".repeat(300) + "需审批，尚未确认。 ";
    const mentor = { user_argument_score: 7.5, strengths: Array(8).fill(long), vulnerabilities: [], tactical_tips: long,
      suggested_replies: Array(6).fill({ title: long, content: long, rationale: long }) };
    const report = { final_package_summary: long, score: 70.5, persuasion_grade: "A", leverage_efficiency: "", mentor_summary: long,
      turn_critiques: [{ turn_no: 2, gain_or_loss: "neutral", summary: long, key_point: long }], real_world_tips: Array(8).fill(long) };
    const input = { ...base, status: "finished", turns: [{ ...turn, mentor_analysis: mentor }], report };
    const before = structuredClone(input);
    expect(readSalaryNegotiationHistory(input, 1)).toMatchObject({ turns: [{ mentor_analysis: mentor }], report });
    expect(input).toEqual(before);
  });
  it("允许空回合、间隔题号和未知旧风格，保留现存顺序与文字", () => {
    expect(readSalaryNegotiationHistory({ ...base, turns: [] }, 1).turns).toEqual([]);
    const result = readSalaryNegotiationHistory({ ...base, turns: [{ ...turn, id: 1, turn_no: 1, user_message: "" }, { ...turn, turn_no: 4 }] }, 1);
    expect(result.hr_style).toBe("legacy-style");
    expect(result.turns.map((entry) => entry.turn_no)).toEqual([1, 4]);
    expect(result.turns[1]!.user_message).toBe(turn.user_message);
  });
  it.each([
    null, [], {}, { ...base, id: 2 }, { ...base, id: "1" }, { ...base, status: "unknown" },
    { ...base, turns: null }, { ...base, turns: [null] }, { ...base, turns: [{ ...turn, negotiation_id: 2 }] },
    { ...base, turns: [{ ...turn, turn_no: "2" }] }, { ...base, turns: [turn, turn] },
    { ...base, turns: [turn, { ...turn, id: 3, turn_no: 1 }] },
    { ...base, turns: [{ ...turn, hr_mindset: null }] }, { ...base, turns: [{ ...turn, mentor_analysis: [] }] },
    { ...base, turns: [{ ...turn, mentor_analysis: { strengths: ["实际文本", 1] } }] },
    { ...base, turns: [{ ...turn, mentor_analysis: { suggested_replies: [null] } }] },
    { ...base, report: { turn_critiques: [{ turn_no: 9, gain_or_loss: "gain" }] } },
    { ...base, report: { turn_critiques: [{ turn_no: 2, gain_or_loss: "gain" }, { turn_no: 2, gain_or_loss: "loss" }] } },
  ])("损坏或串记录整份拒绝，不丢弃坏项后当作空历史（%#）", (input) => {
    expect(() => readSalaryNegotiationHistory(input, 1)).toThrow(NegotiationHistoryError);
  });
});
