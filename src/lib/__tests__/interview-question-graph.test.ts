import { describe, expect, it } from "vitest";
import {
  collectInterviewQuestionGraphTextsExcludingDescendants,
  createInterviewQuestionGraphRoot,
  expandInterviewQuestionGraph,
  parseInterviewQuestionGraphDocument,
  predictInterviewQuestionGraphAnswers,
  parseInterviewQuestionGraphStart,
  validateInterviewQuestionGraphPredictions,
  validateInterviewQuestionGraphExpand,
  validateInterviewQuestionGraphStart,
} from "../interview-question-graph";

const branch = (question: string) => ({ label: "有依据的回答", predicted_answer: "具体操作待确认。", followup_question: question });
const root = "How did you test the API?";
const duplicates = [
  root,
  "  HOW DID YOU TEST THE API？ ",
  "Ｈｏｗ ｄｉｄ ｙｏｕ ｔｅｓｔ ｔｈｅ ＡＰＩ？",
  "How  did\nyou test the API!",
  "Ho\u200bw did you test the API?\u2060\ufeff\u00ad",
];

describe("图谱题目去重协议", () => {
  it.each(duplicates)("拒绝根题的格式变体：%s", (question) => {
    expect(() => validateInterviewQuestionGraphStart({ question: root, branches: [branch(question), branch("Which inputs did you use?")] }))
      .toThrow("重复题目");
  });

  it("拒绝首轮两条分支之间的重复", () => {
    expect(() => parseInterviewQuestionGraphStart(JSON.stringify({ question: "What was your role?", branches: [branch(root), branch(duplicates[1]!)] })))
      .toThrow("重复题目");
  });

  it.each(duplicates)("拒绝已有题目的格式变体：%s", (question) => {
    expect(() => validateInterviewQuestionGraphExpand({ expansions: [{ question_id: "q2-1", branches: [branch(question), branch("Which inputs did you use?")] }] }, ["q2-1"], [root]))
      .toThrow("重复题目");
  });

  it("拒绝同一扩展中重复的追问", () => {
    expect(() => validateInterviewQuestionGraphExpand({ expansions: [{ question_id: "q2-1", branches: [branch(root), branch(duplicates[1]!)] }] }, ["q2-1"], []))
      .toThrow("重复题目");
  });

  it("拒绝一次批量扩展的不同节点间重复的追问", () => {
    expect(() => validateInterviewQuestionGraphExpand({ expansions: [
      { question_id: "q2-1", branches: [branch(root), branch("Which inputs did you use?")] },
      { question_id: "q2-2", branches: [branch("How did you record the result?"), branch(duplicates[1]!)] },
    ] }, ["q2-1", "q2-2"], []))
      .toThrow("重复题目");
  });

  it("保留不同问题的原文、顺序与所属节点", () => {
    const value = { expansions: [
      { question_id: "q2-2", branches: [branch("Which inputs did you use?"), branch("What result did you observe?")] },
      { question_id: "q2-1", branches: [branch("How did you record the result?"), branch("Who can verify the scope?")] },
    ] };
    expect(validateInterviewQuestionGraphExpand(value, ["q2-1", "q2-2"], [root])).toEqual(value);
  });
});

describe("第三层预测回答和节点重生成", () => {
  const start = validateInterviewQuestionGraphStart({
    question: "你负责了什么？",
    branches: [
      { label: "具体", predicted_answer: "负责接口校验。", followup_question: "你检查什么？" },
      { label: "概括", predicted_answer: "参与过联调。", followup_question: "你参与哪次联调？" },
    ],
  });
  const expanded = expandInterviewQuestionGraph(createInterviewQuestionGraphRoot(start), [{
    question_id: "q2-1",
    branches: [
      { label: "具体", predicted_answer: "检查边界值。", followup_question: "如何验证边界值？" },
      { label: "概括", predicted_answer: "查看了请求。", followup_question: "如何记录结果？" },
    ],
  }]);
  const answers = [
    { label: "有实际依据", predicted_answer: "我会说明当时使用的校验记录，具体细节待核实。" },
    { label: "细节待确认", predicted_answer: "我需要先核对记录，再说明具体步骤。" },
  ];

  it("第三层可生成预测回答，保存结构中不带追问", () => {
    const parsed = validateInterviewQuestionGraphPredictions({ predictions: [{ question_id: "q3-q2-1-1", answers }] }, ["q3-q2-1-1"]);
    const predicted = predictInterviewQuestionGraphAnswers(expanded, parsed.predictions);
    const question = predicted.branches[0]!.followup.branches[0]!.followup;

    expect(question.predictedAnswers).toEqual([
      { id: "a4-q3-q2-1-1-1", label: answers[0]!.label, predictedAnswer: answers[0]!.predicted_answer },
      { id: "a4-q3-q2-1-1-2", label: answers[1]!.label, predictedAnswer: answers[1]!.predicted_answer },
    ]);
    expect(JSON.stringify(parseInterviewQuestionGraphDocument(predicted))).not.toContain("followup_question");
  });

  it("重生成二层追问可忽略旧后代去重，并替换整个后续子树", () => {
    const knownForReplacement = collectInterviewQuestionGraphTextsExcludingDescendants(expanded, ["q2-1"]);
    expect(knownForReplacement).toEqual(["你负责了什么？", "你检查什么？", "你参与哪次联调？"]);

    const regenerated = expandInterviewQuestionGraph(expanded, [{
      question_id: "q2-1",
      branches: [
        { label: "全新", predicted_answer: "新的练习回答。", followup_question: "新的核验问题一？" },
        { label: "另一方向", predicted_answer: "另一种练习回答。", followup_question: "新的核验问题二？" },
      ],
    }]);
    expect(regenerated.branches[0]!.followup.branches.map((branch) => branch.followup.question)).toEqual(["新的核验问题一？", "新的核验问题二？"]);
    expect(regenerated.branches[0]!.followup.branches.every((branch) => branch.followup.predictedAnswers?.length === 0)).toBe(true);
  });

  it("第三层预测回答只接受答案字段", () => {
    expect(() => validateInterviewQuestionGraphPredictions({ predictions: [{ question_id: "q3-1", answers: [
      { ...answers[0], followup_question: "不允许追加问题？" }, answers[1],
    ] }] }, ["q3-1"])).toThrow("未声明字段");
  });
});
