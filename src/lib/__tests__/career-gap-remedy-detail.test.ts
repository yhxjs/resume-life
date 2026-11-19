import { expect, it } from "vitest";
import { readCareerGapRemedyDetail } from "../career-gap-remedy-detail";

function saved() {
  const script = { label: "旧标签", applicableScene: "旧场景", script: "原文 <T> &amp;\n".repeat(400), keyPoints: Array(12).fill("原有条件") };
  return { id: 1, raw_story: "完整原稿 <T> &amp;\n".repeat(500), target_role: "历史岗位".repeat(100),
    scenario_type: "legacy-scenario", persona_style: "legacy-persona", created_at: "原始时间", result: {
      title: "旧长标题".repeat(40), punchline: "旧摘要", hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "未提供真实招聘方信息" },
      reframeFormula: { factAcknowledgment: "休息两个月", positiveAttribution: "个人选择", growthAndValue: "未开展学习或项目", motivationAlignment: "未知" },
      scripts: { concise: { ...script, script: "" }, detailed: script, pivoting: { ...script, script: " \n " } },
      drills: [{ question: "原问题", hrConcern: "原关注点", bestResponse: "" }], forbiddenList: [], closingTips: [],
    } };
}

it("合法长历史按原对象回读，不补写空版本、空追问或未知场景风格", () => {
  const row = saved(); const original = structuredClone(row);
  expect(readCareerGapRemedyDetail(row, 1)).toBe(row); expect(row).toEqual(original);
  expect(readCareerGapRemedyDetail({ ...row, result: null }, 1).result).toBeNull();
});

it.each([null, [], "record", 1, true].map(value => [value]))("拒绝错误根结构 %j", value => {
  expect(() => readCareerGapRemedyDetail(value, 1)).toThrow("报告响应不完整或记录不符");
});

it.each([{ id: 2 }, { id: "1" }, { id: 0 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 },
  { raw_story: null }, { target_role: undefined }, { scenario_type: null }, { persona_style: 1 }, { created_at: null },
  { result: undefined }, { result: {} }, { result: [] }, { result: "{}" }])("身份、原稿与报告结构异常 %# 整份拒绝", changed => {
  expect(() => readCareerGapRemedyDetail({ ...saved(), ...changed }, 1)).toThrow("报告响应不完整或记录不符");
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2])("预期记录 %j 无效或不匹配不能认领另一份存档", expectedId => {
  expect(() => readCareerGapRemedyDetail(saved(), expectedId)).toThrow("记录不符");
});
