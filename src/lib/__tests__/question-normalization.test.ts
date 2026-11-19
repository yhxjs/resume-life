import { describe, expect, it } from "vitest";
import { hasQuestionContent, questionComparisonKey } from "../question-normalization";
import { validateInterviewQuestion } from "../model-protocol";
import { INTERVIEW_QUESTION_RULES, MINING_INTERVIEW_RULES, QUESTION_CONTENT_RULES, QUESTION_FORMATTING_DUPLICATE_RULE, STANDALONE_DRILL_QUESTION_RULES } from "../prompt-guidelines";
import { SERIES_FIRST_PROMPT } from "../interview-series-advance-llm";
import { interviewAnswerPrompt } from "../interview-answer-llm";
import { BANK_DRILL_QUESTION_PROMPT, PROJECT_DRILL_QUESTION_PROMPT } from "../drill-question-llm";
import { REMEDIATION_PROMPT } from "../drill-remediation-llm";

describe("问题内容的 Unicode 边界", () => {
  it.each(["\u200b", "\u2060", "\u00ad", "\ufeff"])("题干内及末尾的排版字符不构成新题：%j", formatting => {
    const original = "如何处理 API 缓存失效？";
    const variant = `${formatting}如何处理 A${formatting}PI ${formatting}缓存失效？${formatting}`;
    expect(questionComparisonKey(variant)).toBe(questionComparisonKey(original));
    expect(validateInterviewQuestion(variant)).toBe(variant.trim());
  });

  it.each(["？ ！", "? \n ! \t .", "； \u3000：", "…… \r\n。"])("句末标点之间有空白仍是同题：%j", suffix => {
    expect(questionComparisonKey(`如何处理 API${suffix}`)).toBe(questionComparisonKey("如何处理 API？"));
  });

  it.each([
    ["解释 C++", "解释 C#"],
    ["解释 operator<", "解释 operator>"],
    ["说明 a ? b : c", "说明 a ? c : b"],
    ["说明 foo.bar", "说明 foo bar"],
    ["如何对 میروم 分词", "如何对 می\u200cروم 分词"],
    ["如何渲染 👩💻", "如何渲染 👩\u200d💻"],
    ["如何渲染 ❤", "如何渲染 ❤️"],
  ])("去重保留技术符号和题干内部内容的差别：%j / %j", (first, second) => {
    expect(questionComparisonKey(`${first}？ ！`)).not.toBe(questionComparisonKey(`${second}？ ！`));
    expect(validateInterviewQuestion(`${first}？ ！`)).toBe(`${first}？ ！`);
  });

  it.each([INTERVIEW_QUESTION_RULES, MINING_INTERVIEW_RULES, STANDALONE_DRILL_QUESTION_RULES])("出题提示复用不可见占位规则（%#）", (prompt) => {
    expect(prompt).toContain(QUESTION_CONTENT_RULES);
    expect(prompt).toContain("也不得仅用零宽、控制字符等不可见字符占位");
  });

  it.each([
    MINING_INTERVIEW_RULES, SERIES_FIRST_PROMPT("主管面"), interviewAnswerPrompt("主管面", "manager", false, true),
    BANK_DRILL_QUESTION_PROMPT, PROJECT_DRILL_QUESTION_PROMPT, REMEDIATION_PROMPT,
  ])("组合后的出题提示只包含一次排版字符去重规则（%#）", prompt => {
    expect(prompt.split(QUESTION_FORMATTING_DUPLICATE_RULE)).toHaveLength(2);
  });

  it.each([
    { label: "零宽格式字符", question: "\u200b\u200c\u200d\u2060" },
    { label: "控制字符", question: "\u0000\u0008\u007f" },
    { label: "独立组合音标", question: "\u0301\u0308" },
    { label: "独立变体选择符", question: "\ufe0f" },
    { label: "标点与格式字符", question: "（\u200b）？" },
    { label: "韩文填充字符", question: "\u3164\uffa0" },
    { label: "软连字符", question: "\u00ad" },
  ])("$label 不单独构成问题内容", ({ question }) => {
    expect(hasQuestionContent(question)).toBe(false);
  });

  it.each([
    "C++ 中 operator< 与 operator> 的用途",
    "解释 ∑ 与 O(n) 的关系",
    "1",
    "如何处理 cafe\u0301 中的组合音标？",
    "如何显示 क् 与 मि？",
    "如何对 می\u200cروم 分词？",
    "如何渲染 👩\u200d💻 与 ❤️？",
    "\u200b请说明已知条件\u2060",
  ])("有内容的文本完整保留，不删除语言或技术符号：%j", (question) => {
    expect(hasQuestionContent(question)).toBe(true);
    expect(validateInterviewQuestion(question)).toBe(question);
  });
});
