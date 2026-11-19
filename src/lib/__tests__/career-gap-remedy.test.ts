import { describe, expect, it } from "vitest";
import { normalizeRemedyResult, parseRemedyResult, type ResignationGapRemedyResult } from "../career-gap-remedy";

function savedReport(): ResignationGapRemedyResult {
  return {
    title: "休整经历", punchline: "保留事实和待确认安排",
    hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "到岗安排尚未确认" },
    reframeFormula: { factAcknowledgment: "休整六个月", positiveAttribution: "个人选择", growthAndValue: "未提供成果", motivationAlignment: "[待补充：岗位方向]" },
    scripts: Object.fromEntries(["concise", "detailed", "pivoting"].map((key) => [key, {
      label: key, applicableScene: "初步沟通", script: `原始 ${key} 话术：未开展项目，尚未确认到岗安排`, keyPoints: ["保留真实范围"],
    }])) as ResignationGapRemedyResult["scripts"],
    drills: [{ question: "目前如何安排时间？", hrConcern: "可能核实到岗条件", bestResponse: "[待补充：真实安排]" }],
    forbiddenList: ["不编造项目成果"], closingTips: ["只说明岗位相关安排"],
  };
}

function changed(field: string, value: unknown) {
  const output = savedReport() as unknown as Record<string, unknown>;
  const keys = field.split(".");
  let target = output;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return JSON.stringify(output);
}

describe("空窗历史报告的读取边界", () => {
  it.each(["not JSON", "null", "[]", "{}", '{"scripts":true}', '{"scripts":{"concise":{"script":"尚未确认"}}}'])("损坏结构 %s 不冒充完整报告", (json) => {
    expect(parseRemedyResult(json)).toBeNull();
  });

  it.each([
    ["title", 3], ["punchline", {}], ["hrMindsetAnalysis", []], ["hrMindsetAnalysis.coreConcerns", null],
    ["hrMindsetAnalysis.riskPoints", ["保留", {}]], ["hrMindsetAnalysis.whatHrWantsToHear", false],
    ["reframeFormula", null], ["reframeFormula.factAcknowledgment", 1], ["reframeFormula.positiveAttribution", []],
    ["reframeFormula.growthAndValue", false], ["reframeFormula.motivationAlignment", {}],
    ["scripts", "旧数据"], ["scripts.concise", null], ["scripts.detailed.label", 1],
    ["scripts.pivoting.applicableScene", false], ["scripts.pivoting.script", {}], ["scripts.concise.keyPoints", [null]],
    ["drills", {}], ["drills", [null]], ["drills", [{ question: "缺少原回答" }]],
    ["forbiddenList", null], ["closingTips", [1]],
  ])("%s 类型无效时整份转入恢复入口，不拼接默认建议", (field, value) => {
    expect(parseRemedyResult(changed(field as string, value))).toBeNull();
  });

  it("三版话术都为空时不展示一份空报告", () => {
    const saved = savedReport();
    for (const script of Object.values(saved.scripts)) script.script = " \n ";
    expect(parseRemedyResult(JSON.stringify(saved))).toBeNull();
  });

  it.each(["concise", "detailed", "pivoting"] as const)("历史报告仅 %s 有正文时仍完整读取，空版本不被默认内容替代", (available) => {
    const saved = savedReport();
    for (const key of ["concise", "detailed", "pivoting"] as const) {
      if (key !== available) saved.scripts[key].script = " \n ";
    }
    expect(parseRemedyResult(JSON.stringify(saved))).toEqual(saved);
  });

  it("旧报告的长文本、末尾限定、换行、实体字符与额外条目完整回读", () => {
    const saved = savedReport();
    saved.title = "标题".repeat(50) + "尚未确认";
    saved.scripts.concise.script = "已记录的原始经历。".repeat(120) + "\n但未开展项目；<T> &amp; 仅是原字符，到岗条件尚未确认。";
    saved.hrMindsetAnalysis.coreConcerns = Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 项可能关注点：${"原话".repeat(60)}，仍待确认`);
    saved.drills = Array.from({ length: 7 }, (_, i) => ({ ...saved.drills[0]!, question: `第 ${i + 1} 项原问题：${"原话".repeat(90)}`, bestResponse: "原回答".repeat(150) + "，未承诺到岗" }));
    const json = JSON.stringify(saved);
    expect(parseRemedyResult(json)).toEqual(saved);
    expect(JSON.stringify(saved)).toBe(json);
  });

  it("空分析或无追问不被补造为问题、心理结论或成长成果", () => {
    const saved = { ...savedReport(), drills: [], forbiddenList: [], closingTips: [] };
    expect(parseRemedyResult(JSON.stringify(saved))).toEqual(saved);
  });
});

describe("沟通方案的异常清洗兜底", () => {
  it("缺失字段时不补造情绪判断、成长经历或必胜式话术", () => {
    const result = normalizeRemedyResult({
      scripts: { concise: { script: "按事实说明" } },
      drills: [{ question: "你希望补充哪些真实安排？" }],
    });
    expect(result?.punchline).toContain("按已知事实准备表达");
    expect(result?.hrMindsetAnalysis.whatHrWantsToHear).toContain("无法仅凭当前材料确定");
    expect(result?.reframeFormula.growthAndValue).toContain("未提供相关行动或认识");
    expect(result?.scripts.detailed.script).toContain("话术未生成");
    expect(result?.scripts.detailed.keyPoints).toEqual([]);
    expect(result?.drills[0]?.hrConcern).toContain("无法仅凭当前材料确定");
    expect(result?.closingTips).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/必杀技|高情商|情绪稳定|自我沉淀与赋能|成熟职业素养|真实心态|眼神交流|情绪价值|展现价值/);
  });
});
