import { describe, expect, it } from "vitest";
import {
  ModelProtocolError,
  parseDefenseDrillEvaluation,
  parseInterviewAnswerDecision,
} from "../model-protocol";

const validDefenseEvaluation = {
  defense_score: 87.5,
  interviewer_roast: "点评",
  defense_critique: "剖析",
  improved_answer: "示范回答",
};

const validInterviewDecision = {
  depth: 8,
  structure: 7,
  authenticity: 9,
  completeness: 6,
  comment: "点评",
  next_kind: "followup",
  next_question: "下一题",
};

function expectProtocolError(run: () => unknown) {
  expect(run).toThrow(ModelProtocolError);
}

describe("parseDefenseDrillEvaluation", () => {
  it("解析并裁剪合法的结构化评价", () => {
    const result = parseDefenseDrillEvaluation(JSON.stringify({
      ...validDefenseEvaluation,
      interviewer_roast: "  点评  ",
      defense_critique: "\n剖析\n",
      improved_answer: "  示范回答\t",
    }));

    expect(result).toEqual(validDefenseEvaluation);
  });

  it.each([
    ["前后垃圾", `模型输出：${JSON.stringify(validDefenseEvaluation)}，结束`],
    ["合法对象后追加截断 JSON", `${JSON.stringify(validDefenseEvaluation)}\n{"extra":`],
    ["JSON 代码围栏", `\`\`\`json\n${JSON.stringify(validDefenseEvaluation)}\n\`\`\``],
  ])("拒绝%s", (_label, raw) => {
    expectProtocolError(() => parseDefenseDrillEvaluation(raw));
  });

  it.each([
    ["无效 JSON", "{broken"],
    ["截断 JSON", '{"defense_score": 80'],
    ["null 根值", "null"],
    ["数组根值", "[]"],
    ["缺少字段", JSON.stringify({ defense_score: 80 })],
    ["字符串分数", JSON.stringify({ ...validDefenseEvaluation, defense_score: "80" })],
    ["NaN 分数", '{"defense_score":NaN,"interviewer_roast":"点评","defense_critique":"剖析","improved_answer":"示范"}'],
    ["Infinity 分数", '{"defense_score":1e309,"interviewer_roast":"点评","defense_critique":"剖析","improved_answer":"示范"}'],
    ["负 Infinity 分数", '{"defense_score":-1e309,"interviewer_roast":"点评","defense_critique":"剖析","improved_answer":"示范"}'],
    ["负分", JSON.stringify({ ...validDefenseEvaluation, defense_score: -1 })],
    ["超范围分数", JSON.stringify({ ...validDefenseEvaluation, defense_score: 101 })],
    ["点评类型错误", JSON.stringify({ ...validDefenseEvaluation, interviewer_roast: 42 })],
    ["点评为空", JSON.stringify({ ...validDefenseEvaluation, interviewer_roast: " \n " })],
    ["剖析为空", JSON.stringify({ ...validDefenseEvaluation, defense_critique: "" })],
    ["示范回答为空", JSON.stringify({ ...validDefenseEvaluation, improved_answer: "\t" })],
  ])("拒绝%s", (_label, raw) => {
    expectProtocolError(() => parseDefenseDrillEvaluation(raw));
  });
});

describe("parseInterviewAnswerDecision", () => {
  it.each([0, 10])("接受四维评分边界 %s", (score) => {
    const decision = { ...validInterviewDecision, depth: score, structure: score, authenticity: score, completeness: score };
    expect(parseInterviewAnswerDecision(JSON.stringify(decision))).toEqual(decision);
  });

  it.each(["followup", "question"] as const)("解析并裁剪合法的 %s 决策", (nextKind) => {
    const result = parseInterviewAnswerDecision(JSON.stringify({
      ...validInterviewDecision,
      comment: "  点评  ",
      next_kind: nextKind,
      next_question: "\n下一题\n",
    }));

    expect(result).toEqual({
      ...validInterviewDecision,
      next_kind: nextKind,
    });
  });

  it.each([
    ["前后垃圾", `模型输出：${JSON.stringify(validInterviewDecision)}，结束`],
    ["合法对象后追加截断 JSON", `${JSON.stringify(validInterviewDecision)}\n{"extra":`],
    ["JSON 代码围栏", `\`\`\`json\n${JSON.stringify(validInterviewDecision)}\n\`\`\``],
  ])("拒绝%s", (_label, raw) => {
    expectProtocolError(() => parseInterviewAnswerDecision(raw));
  });

  it.each([
    ["无效 JSON", "not json"],
    ["截断 JSON", '{"depth":8'],
    ["null 根值", "null"],
    ["数组根值", "[]"],
    ["缺少字段", JSON.stringify({ depth: 8 })],
    ["字符串分数", JSON.stringify({ ...validInterviewDecision, depth: "8" })],
    ["小数分数", JSON.stringify({ ...validInterviewDecision, structure: 7.5 })],
    ["负分", JSON.stringify({ ...validInterviewDecision, authenticity: -1 })],
    ["超范围分数", JSON.stringify({ ...validInterviewDecision, completeness: 11 })],
    ["Infinity 分数", '{"depth":1e309,"structure":7,"authenticity":9,"completeness":6,"comment":"点评","next_kind":"question","next_question":"下一题"}'],
    ["空点评", JSON.stringify({ ...validInterviewDecision, comment: " \n " })],
    ["点评类型错误", JSON.stringify({ ...validInterviewDecision, comment: null })],
    ["非法 next_kind", JSON.stringify({ ...validInterviewDecision, next_kind: "done" })],
    ["空 next_question", JSON.stringify({ ...validInterviewDecision, next_question: "\t" })],
    ["next_question 类型错误", JSON.stringify({ ...validInterviewDecision, next_question: 42 })],
  ])("拒绝%s", (_label, raw) => {
    expectProtocolError(() => parseInterviewAnswerDecision(raw));
  });
});
