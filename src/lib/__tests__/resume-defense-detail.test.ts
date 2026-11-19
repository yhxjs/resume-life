import { describe, expect, it } from "vitest";
import { readDefenseDetail } from "../resume-defense-detail";

function detail() {
  return {
    report: {
      id: 1, resumeId: null, title: "历史报告", sourceContent: "原稿 <T> &amp;\n尚未上线", targetRole: "接口工程师",
      riskLevel: "medium", overallRoast: "核对分工", createdAt: "2026-10-29", items: [{
        id: "item_1", originalText: "旧引用 <T> &amp;", sectionHint: "经历", riskLevel: "medium", riskType: "scope_ambiguity",
        interviewerRoast: "待核实", deadlyQuestions: ["分工？"],
        defensePlan: { interviewerIntent: "核对", standardDefense: "仅说明事实", tabooMistakes: ["编造经历"] },
      }],
    },
    drills: [{ id: 10, defenseId: 1, itemId: "item_1", question: "旧题目", userAnswer: "原答", defenseScore: 85,
      interviewerRoast: "点评", defenseCritique: "待补充", improvedAnswer: "参考", createdAt: "2026-10-29", updatedAt: "2026-10-29" }],
  };
}

describe("排雷详情历史协议", () => {
  it("完整历史原样接受，不套用新生成数量、长度或引用匹配规则，也不要求原题仍在追问列表", () => {
    const value = detail();
    value.report.title = "历史_".repeat(5000);
    value.report.sourceContent = "原文 <T> &amp;\n".repeat(10000);
    value.report.items = Array.from({ length: 15 }, (_, index) => ({ ...value.report.items[0]!, id: `item_${index + 1}` }));
    const before = structuredClone(value);
    expect(readDefenseDetail(value, "1")).toBe(value);
    expect(value).toEqual(before);
  });

  it("真实空报告、空字段、缺省关联元数据及未知评级可读，不补造记录", () => {
    const value = { report: { ...detail().report, resumeId: undefined, resumeVersionId: undefined, riskLevel: null, items: [] }, drills: [] };
    expect(readDefenseDetail(value, "1")).toBe(value);
    const unknown = detail();
    unknown.report.riskLevel = "legacy"; unknown.report.items[0]!.riskType = "legacy";
    unknown.report.items[0]!.deadlyQuestions = []; unknown.report.items[0]!.defensePlan.tabooMistakes = [];
    expect(readDefenseDetail(unknown, "1")).toBe(unknown);
  });

  it.each([null, [], {}, { report: null, drills: [] }, { report: detail().report }, { report: detail().report, drills: null }])("拒绝不完整外壳 %#", (value) => {
    expect(() => readDefenseDetail(value, "1")).toThrow("排雷报告响应不完整");
  });

  it.each([
    { id: 2 }, { id: "1" }, { id: 1.5 }, { id: 0 }, { id: 9007199254740992 },
    { title: null }, { sourceContent: [] }, { targetRole: {} }, { overallRoast: null }, { createdAt: 123 },
    { resumeId: -1 }, { resumeVersionId: "1" }, { riskLevel: {} }, { items: null },
  ])("拒绝串报告、无效身份与展示字段 %#", (patch) => {
    expect(() => readDefenseDetail({ ...detail(), report: { ...detail().report, ...patch } }, "1")).toThrow();
  });

  it.each([
    { id: "" }, { id: " " }, { id: 3 }, { originalText: {} }, { sectionHint: null }, { interviewerRoast: [] },
    { riskType: {} }, { riskLevel: [] }, { deadlyQuestions: null }, { deadlyQuestions: ["有效", {}] },
    { defensePlan: null }, { defensePlan: { interviewerIntent: "核对", standardDefense: null, tabooMistakes: [] } },
    { defensePlan: { interviewerIntent: "核对", standardDefense: "参考", tabooMistakes: [false] } },
  ])("任一坏条目使整份拒绝，不部分展示 %#", (patch) => {
    const value = detail();
    const item = { ...value.report.items[0]!, ...patch };
    expect(() => readDefenseDetail({ ...value, report: { ...value.report, items: [value.report.items[0], item] } }, "1")).toThrow();
    expect(() => readDefenseDetail({ ...value, report: { ...value.report, items: [item] } }, "1")).toThrow();
  });

  it("重复条目、演练 ID 或同条目多份演练不能互相覆盖", () => {
    const value = detail();
    expect(() => readDefenseDetail({ ...value, report: { ...value.report, items: [...value.report.items, ...value.report.items] } }, "1")).toThrow();
    expect(() => readDefenseDetail({ ...value, drills: [...value.drills, ...value.drills] }, "1")).toThrow();
    expect(() => readDefenseDetail({ ...value, drills: [...value.drills, { ...value.drills[0], id: 11 }] }, "1")).toThrow();
  });

  it.each([
    { id: 0 }, { id: "10" }, { defenseId: 2 }, { defenseId: "1" }, { itemId: "other" },
    { question: null }, { userAnswer: {} }, { interviewerRoast: [] }, { defenseCritique: false },
    { improvedAnswer: {} }, { createdAt: 1 }, { updatedAt: null },
    { defenseScore: null }, { defenseScore: "85" }, { defenseScore: NaN }, { defenseScore: Infinity },
  ])("拒绝串演练、无效字段和非数字分数 %#", (patch) => {
    const value = detail();
    expect(() => readDefenseDetail({ ...value, drills: [{ ...value.drills[0], ...patch }] }, "1")).toThrow();
  });

  it("范围外的历史数字保留以便显示未提供有效分数，不夹取或伪装成零分", () => {
    const value = detail(); value.drills[0]!.defenseScore = 101;
    expect(readDefenseDetail(value, "1").drills[0]!.defenseScore).toBe(101);
  });
});
