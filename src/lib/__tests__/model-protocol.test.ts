import { describe, expect, it } from "vitest";
import {
  ModelProtocolError,
  parseDefenseDrillEvaluation,
  RESUME_DEFENSE_DRILL_OUTPUT_LIMITS,
  parseInterviewAnswerDecision,
  parseInterviewRetryEvaluation,
  INTERVIEW_ANSWER_OUTPUT_LIMITS,
  parseInterviewReference,
  parseReverseInterviewResponse,
  validateInterviewQuestion,
} from "../model-protocol";
import { INTERVIEW_QUESTION_MAX_CHARS } from "../prompt-guidelines";

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

describe("parseReverseInterviewResponse", () => {
  it.each([
    [1, "有待提升"], [2, "有待提升"], [3, "一般"], [4, "一般"], [5, "良好"],
    [6, "良好"], [7, "优秀"], [8, "优秀"], [9, "卓越"], [10, "卓越"],
  ])("分数 %i 统一计算为 %s，不依赖模型重复生成评级", (score, level) => {
    const result = parseReverseInterviewResponse(JSON.stringify({
      answer: "模拟回答，团队内部情况仍待确认",
      evaluation: { score, insight: "关注岗位安排", feedback: "问题具体", suggestions: "追问执行依据" },
    }));
    expect(result.evaluation).toEqual({ score, level, insight: "关注岗位安排", feedback: "问题具体", suggestions: "追问执行依据" });
  });

  it.each([
    { answer: "答复", evaluation: { score: 8, insight: "观察", feedback: "点评", suggestions: "建议", level: "优秀" } },
    { answer: "答复", evaluation: { score: 8, insight: "观察", feedback: "点评", suggestions: "建议", extra: true } },
    { answer: "答复", evaluation: { score: 8, insight: "观察", feedback: "点评", suggestions: "建议" }, extra: true },
  ])("拒绝反问评估中的派生等级或协议外字段 %#", (value) => {
    expectProtocolError(() => parseReverseInterviewResponse(JSON.stringify(value)));
  });
});

function expectProtocolError(run: () => unknown) {
  expect(run).toThrow(ModelProtocolError);
}

describe("新生成模型 JSON 的键唯一性", () => {
  it.each([8, 2])("拒绝重答的重复评分键，即使最后值为 %i", (depth) => {
    const raw = `{"depth":8,"structure":7,"authenticity":9,"completeness":6,"comment":"点评","reference":"参考回答","depth":${depth}}`;
    expectProtocolError(() => parseInterviewRetryEvaluation(raw));
  });

  it("拒绝转义后相同的回答决策键，末题也不例外", () => {
    const raw = JSON.stringify(validInterviewDecision).replace(/}$/, ',"\\u0064epth":2}');
    expectProtocolError(() => parseInterviewAnswerDecision(raw));
    expectProtocolError(() => parseInterviewAnswerDecision(raw, { finalTurn: true }));
  });

  it("拒绝嵌套反问评估中的重复分数", () => {
    expectProtocolError(() => parseReverseInterviewResponse('{"answer":"模拟回答","evaluation":{"score":1,"insight":"观察","feedback":"点评","suggestions":"建议","score":9}}'));
  });

  it("拒绝重复参考答案，不将后一段作为唯一原文", () => {
    expectProtocolError(() => parseInterviewReference('{"reference":"未上线","reference":"已上线"}'));
  });
});

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
    ["interviewer_roast", RESUME_DEFENSE_DRILL_OUTPUT_LIMITS.interviewer_roast],
    ["defense_critique", RESUME_DEFENSE_DRILL_OUTPUT_LIMITS.defense_critique],
    ["improved_answer", RESUME_DEFENSE_DRILL_OUTPUT_LIMITS.improved_answer],
  ] as const)("%s 接受上限内全文、拒绝超限内容", (field, max) => {
    const atLimit = { ...validDefenseEvaluation, [field]: "字".repeat(max) };
    expect(parseDefenseDrillEvaluation(JSON.stringify(atLimit))[field]).toHaveLength(max);
    expectProtocolError(() => parseDefenseDrillEvaluation(JSON.stringify({ ...atLimit, [field]: "字".repeat(max + 1) })));
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
    ["额外字段", JSON.stringify({ ...validDefenseEvaluation, internal_note: "额外内容" })],
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
  it("点评接受恰好达到硬上限并拒绝超限", () => {
    const atLimit = "评".repeat(INTERVIEW_ANSWER_OUTPUT_LIMITS.comment);
    expect(parseInterviewAnswerDecision(JSON.stringify({ ...validInterviewDecision, comment: atLimit })).comment).toBe(atLimit);
    expectProtocolError(() => parseInterviewAnswerDecision(JSON.stringify({ ...validInterviewDecision, comment: `${atLimit}评` })));
  });

  it.each(["？？？", "！ \n？", "【……】；", "\u200b", "\u0000", "\u0301\ufe0f", "（\u200b）？", "\u3164"])("拒绝无内容的首题和非末题下一题 %j", (question) => {
    expect(() => validateInterviewQuestion(question)).toThrow(ModelProtocolError);
    expect(() => parseInterviewAnswerDecision(JSON.stringify({ ...validInterviewDecision, next_question: question }))).toThrow(ModelProtocolError);
    expect(parseInterviewAnswerDecision(JSON.stringify({ ...validInterviewDecision, next_question: question }), { finalTurn: true }).next_question).toBe("");
  });

  it.each(["C++ 中的 ++ 和 + 有什么区别？", "1 + 1 为什么不总能直接用于字符串拼接？", "解释 ∑ 与 O(n) 的关系。"])("技术符号与数字不导致有效题目被改写或拒绝：%j", (question) => {
    expect(validateInterviewQuestion(` ${question} `)).toBe(question);
  });

  it("允许恰好达到题目长度上限并拒绝超限", () => {
    const atLimit = "题".repeat(INTERVIEW_QUESTION_MAX_CHARS);
    expect(validateInterviewQuestion(atLimit)).toBe(atLimit);
    expect(() => validateInterviewQuestion(`${atLimit}题`)).toThrow("不能超过");
    expect(() => validateInterviewQuestion(" \n ")).toThrow("非空字符串");
  });

  it.each(["", "  ", "旧版模型仍生成了下一题", "题".repeat(INTERVIEW_QUESTION_MAX_CHARS + 1)])("最后一题接受文本字段并清除不再使用的下一题：%j", (nextQuestion) => {
    expect(parseInterviewAnswerDecision(JSON.stringify({
      ...validInterviewDecision, next_question: nextQuestion,
    }), { finalTurn: true })).toEqual({ ...validInterviewDecision, next_kind: "question", next_question: "" });
  });

  it.each([undefined, null, 42])("最后一题仍拒绝缺失或类型错误的下一题字段：%j", (nextQuestion) => {
    expectProtocolError(() => parseInterviewAnswerDecision(JSON.stringify({
      ...validInterviewDecision, next_question: nextQuestion,
    }), { finalTurn: true }));
  });

  it("模型自行声称结束不能绕过非末题的下一题校验", () => {
    expectProtocolError(() => parseInterviewAnswerDecision(JSON.stringify({
      ...validInterviewDecision, next_question: "", finished: true, finalTurn: true,
    })));
  });

  it("回答决策拒绝固定输出结构之外的顶层字段", () => {
    expectProtocolError(() => parseInterviewAnswerDecision(JSON.stringify({ ...validInterviewDecision, extra: true })));
  });

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
    ["不可见字符点评", JSON.stringify({ ...validInterviewDecision, comment: "\u200b\u2060" })],
    ["点评类型错误", JSON.stringify({ ...validInterviewDecision, comment: null })],
    ["非法 next_kind", JSON.stringify({ ...validInterviewDecision, next_kind: "done" })],
    ["空 next_question", JSON.stringify({ ...validInterviewDecision, next_question: "\t" })],
    ["next_question 类型错误", JSON.stringify({ ...validInterviewDecision, next_question: 42 })],
  ])("拒绝%s", (_label, raw) => {
    expectProtocolError(() => parseInterviewAnswerDecision(raw));
  });
});

describe("parseInterviewRetryEvaluation 输出长度", () => {
  const valid = { depth: 7, structure: 7, authenticity: 7, completeness: 7, comment: "点评", reference: "参考答案" };
  it("在上限内保留点评和参考答案，分别拒绝超限输出", () => {
    const comment = "评".repeat(INTERVIEW_ANSWER_OUTPUT_LIMITS.comment);
    const reference = "参".repeat(INTERVIEW_ANSWER_OUTPUT_LIMITS.reference);
    expect(parseInterviewRetryEvaluation(JSON.stringify({ ...valid, comment, reference }))).toMatchObject({ comment, reference });
    expectProtocolError(() => parseInterviewRetryEvaluation(JSON.stringify({ ...valid, comment: `${comment}评` })));
    expectProtocolError(() => parseInterviewRetryEvaluation(JSON.stringify({ ...valid, reference: `${reference}参` })));
  });

  it.each(["comment", "reference"] as const)("重评拒绝仅含不可见字符的 %s", (field) => {
    expectProtocolError(() => parseInterviewRetryEvaluation(JSON.stringify({ ...valid, [field]: "\u200b\u2060" })));
  });
});

describe("面试参考答案与反问输出长度", () => {
  it("参考答案拒绝仅含不可见字符的占位内容", () => {
    expectProtocolError(() => parseInterviewReference(JSON.stringify({ reference: "\u200b\u2060" })));
  });
  it("参考答案接受上限并拒绝超限", () => {
    const reference = "答".repeat(INTERVIEW_ANSWER_OUTPUT_LIMITS.reference);
    expect(parseInterviewReference(JSON.stringify({ reference }))).toBe(reference);
    expectProtocolError(() => parseInterviewReference(JSON.stringify({ reference: `${reference}答` })));
  });

  it("反问模拟回答与每项评价文本均受硬上限约束", () => {
    const base = { answer: "模拟回答", evaluation: { score: 8, insight: "洞察", feedback: "点评", suggestions: "建议" } };
    const fields = [
      ["answer", INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseAnswer],
      ["insight", INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseEvaluationText],
      ["feedback", INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseEvaluationText],
      ["suggestions", INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseEvaluationText],
    ] as const;
    for (const [field, limit] of fields) {
      const output = field === "answer"
        ? { ...base, answer: "答".repeat(limit) }
        : { ...base, evaluation: { ...base.evaluation, [field]: "评".repeat(limit) } };
      expect(() => parseReverseInterviewResponse(JSON.stringify(output))).not.toThrow();
      const oversized = field === "answer"
        ? { ...base, answer: "答".repeat(limit + 1) }
        : { ...base, evaluation: { ...base.evaluation, [field]: "评".repeat(limit + 1) } };
      expectProtocolError(() => parseReverseInterviewResponse(JSON.stringify(oversized)));
    }
  });
});
