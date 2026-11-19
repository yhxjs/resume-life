import { describe, expect, it } from "vitest";
import { parseJdPortraitResult, type JdPortraitResult } from "../jd-portrait";
import { parseJargonDecoderResult, type JargonDecoderResult } from "../jargon-decoder";

const jd: JdPortraitResult = {
  role: "平台开发，岗位级别未说明",
  mustSkills: [{ name: "TypeScript", weight: 8, why: "要求维护现有平台，规模尚未说明" }],
  followups: [{ topic: "类型设计", questions: ["如果需要兼容旧接口，你会如何处理？"] }],
  companyStyle: { style: "团队风格信息不足", signals: ["维护已有平台"] },
};
const jargon: JargonDecoderResult = {
  targetSummary: "工作安排文本", punchline: "需核实时间边界", overallRiskScore: 40,
  riskRatings: { overtime: 4, stability: null, resources: null, management: null },
  items: [{
    keyword: "弹性工作制", surfaceMeaning: "工作时间可灵活安排", hiddenMeaning: "尚未说明核心协作时段",
    riskLevel: "medium", riskCategory: "协作时间", warning: "若要求持续在线，可能影响休息",
    interviewRule: "核实安排后表达真实可用时间", counterQuestions: ["非工作时间有哪些响应约定？"],
  }],
  companyProfile: { teamStyle: "信息不足", riskFlags: [], cultureSummary: "不能仅据文本确认真实工时" },
  goldenQuestions: ["最近一次紧急响应如何安排？"],
};

function changed(report: unknown, field: string, value: unknown): string {
  const output = structuredClone(report) as Record<string, unknown>;
  const keys = field.split(".");
  let target = output;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return JSON.stringify(output);
}

describe("工具历史报告的展示结构", () => {
  it.each(["null", "[]", "{}", "not json", '{"mustSkills":[]}', '{"items":[]}'])("残缺根值 %s 不进入详情渲染", (json) => {
    expect(parseJdPortraitResult(json)).toBeNull();
    expect(parseJargonDecoderResult(json)).toBeNull();
  });

  it.each([
    ["role", {}], ["mustSkills", null], ["mustSkills", [null]], ["mustSkills.0.name", 1],
    ["mustSkills.0.why", {}], ["mustSkills.0.weight", null], ["mustSkills.0.weight", "8"],
    ["mustSkills.0.weight", 0], ["mustSkills.0.weight", 11], ["mustSkills.0.weight", 2.5],
    ["followups", {}], ["followups", [null]], ["followups.0.topic", []],
    ["followups.0.questions", null], ["followups.0.questions", ["原问题", {}]],
    ["companyStyle", null], ["companyStyle.style", {}], ["companyStyle.signals", false],
    ["companyStyle.signals", ["原信号", {}]],
  ])("JD %s 类型损坏时整份交给恢复页面（%#）", (field, value) => {
    expect(parseJdPortraitResult(changed(jd, field as string, value))).toBeNull();
  });

  it.each([
    ["targetSummary", {}], ["punchline", 1], ["items", false], ["items", [null]],
    ["items.0.keyword", {}], ["items.0.surfaceMeaning", []], ["items.0.hiddenMeaning", null],
    ["items.0.riskCategory", false], ["items.0.warning", {}], ["items.0.interviewRule", 2],
    ["items.0.counterQuestions", undefined], ["items.0.counterQuestions", ["原问题", {}]],
    ["companyProfile", null], ["companyProfile.teamStyle", {}], ["companyProfile.cultureSummary", false],
    ["companyProfile.riskFlags", {}], ["companyProfile.riskFlags", [null]],
    ["goldenQuestions", {}], ["goldenQuestions", ["原问题", {}]],
  ])("黑话 %s 类型损坏时整份交给恢复页面（%#）", (field, value) => {
    expect(parseJargonDecoderResult(changed(jargon, field as string, value))).toBeNull();
  });

  it("旧 JD 长文本、额外考点与末尾限定完整保留，不重新排序或删重", () => {
    const original = structuredClone(jd);
    const long = "原文 <T> &amp;。".repeat(100) + "\n但规模、权限与工时尚未确认。";
    original.role = long;
    original.mustSkills = Array.from({ length: 10 }, () => ({ name: long, weight: 8, why: long }));
    original.followups = Array.from({ length: 8 }, () => ({ topic: long, questions: Array(7).fill(long) }));
    original.companyStyle = { style: long, signals: Array(7).fill(long) };
    const json = JSON.stringify(original);
    expect(parseJdPortraitResult(json)).toEqual(original);
    expect(JSON.stringify(original)).toBe(json);
    expect(parseJdPortraitResult(JSON.stringify({ ...jd, mustSkills: [], followups: [], companyStyle: { style: "", signals: [] } })))
      .toEqual({ ...jd, mustSkills: [], followups: [], companyStyle: { style: "", signals: [] } });
  });

  it("旧黑话长解释、额外条目与问题逐字回读，不自动删去未知或条件", () => {
    const original = structuredClone(jargon);
    const long = "原文 <T> &amp;。".repeat(100) + "\n尚需核实，未承诺随时在线。";
    original.items = Array.from({ length: 10 }, () => ({ ...jargon.items[0]!, hiddenMeaning: long, counterQuestions: Array(7).fill(long) }));
    original.companyProfile = { teamStyle: long, riskFlags: Array(8).fill(long), cultureSummary: long };
    original.goldenQuestions = Array(8).fill(long);
    const json = JSON.stringify(original);
    expect(parseJargonDecoderResult(json)).toEqual(original);
    expect(JSON.stringify(original)).toBe(json);
    expect(parseJargonDecoderResult(JSON.stringify({ ...jargon, items: [], goldenQuestions: [] })))
      .toEqual({ ...jargon, items: [], goldenQuestions: [] });
  });

  it.each([undefined, null, true, [], "损坏评分", { overtime: false, stability: 11, resources: {}, management: -1 }].map((value) => [value]))(
    "旧评分 %j 无效不抹掉正文，也不补为低风险", (riskRatings) => {
      const original = { ...jargon, overallRiskScore: false, riskRatings, items: [{ ...jargon.items[0]!, riskLevel: "未知" }] };
      expect(parseJargonDecoderResult(JSON.stringify(original))).toEqual({
        ...jargon, overallRiskScore: null,
        riskRatings: { overtime: null, stability: null, resources: null, management: null },
        items: [{ ...jargon.items[0]!, riskLevel: null }],
      });
    },
  );
});
