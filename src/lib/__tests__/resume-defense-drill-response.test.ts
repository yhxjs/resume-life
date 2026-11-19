import { describe, expect, it } from "vitest";
import { readDefenseDrill } from "../resume-defense-detail";

const command = { question: "你负责哪些部分？ <T> &amp;", userAnswer: "仅参与校验\n尚未上线 <T> &amp;" };
const record = () => ({ id: 10, defenseId: 1, itemId: "item_1", ...command, defenseScore: 87.5,
  interviewerRoast: "说明了分工", defenseCritique: "仍需验证", improvedAnswer: "仅说明已知事实", createdAt: "2026-10-29", updatedAt: "2026-10-29" });

describe("演练完成响应与提交快照", () => {
  it("合法小数评分与内部原文完整保留，不截断、解码或改写", () => {
    const value = record();
    value.interviewerRoast = "历史长点评 <T> &amp;\n".repeat(5000);
    const before = structuredClone(value);
    expect(readDefenseDrill(value, 1, "item_1", command)).toBe(value); expect(value).toEqual(before);
  });

  it.each([null, {}, [], { ...record(), id: 0 }, { ...record(), id: "10" }, { ...record(), id: 9007199254740992 },
    { ...record(), defenseId: 2 }, { ...record(), itemId: "item_2" },
    { ...record(), question: "另一道题" }, { ...record(), userAnswer: "另一份原答" },
    { ...record(), question: ` ${command.question}` }, { ...record(), userAnswer: `${command.userAnswer} ` },
    { ...record(), defenseScore: null }, { ...record(), defenseScore: "87.5" }, { ...record(), defenseScore: -1 },
    { ...record(), defenseScore: 101 }, { ...record(), defenseScore: NaN }, { ...record(), defenseScore: Infinity },
    { ...record(), interviewerRoast: {} }, { ...record(), defenseCritique: " " }, { ...record(), improvedAnswer: null },
    { ...record(), createdAt: "" }, { ...record(), updatedAt: false }].map((value) => ({ value })))("拒绝坏外壳、串报告/条目/原答与无效评估 %#", ({ value }) => {
    expect(() => readDefenseDrill(value, 1, "item_1", command)).toThrow("演练评估响应不完整或记录不符");
  });

  it.each([0, 100])("%i 分可正常接受，不改成默认分数", (score) => {
    expect(readDefenseDrill({ ...record(), defenseScore: score }, 1, "item_1", command).defenseScore).toBe(score);
  });
});
