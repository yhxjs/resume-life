import { ModelProtocolError, validateInterviewQuestion } from "@/lib/model-protocol";
import { INTERVIEW_QUESTION_RULES, SERIES_CONTEXT_RULES } from "@/lib/prompt-guidelines";
import { SERIES_ROUNDS } from "@/lib/series";
import { questionComparisonKey } from "@/lib/question-normalization";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";

export const SERIES_FIRST_PROMPT = (persona: string) => `你是面试官（你的人设：${persona}），正在主持候选人的进阶面试（共 ${SERIES_ROUNDS} 轮：一面技术面、二面主管面、三面 HR 面）。出题、追问与点评都要符合这个人设。
请根据【岗位要求】与【候选人简历】出第一道面试题，结合前轮题目记录选择符合本轮职责的新侧面。
出题策略：优先从简历上的项目/工作经历深挖，也可结合岗位要求出相关基础题；选一个具体角度作为首题，不套用“背景、分工、沟通、结果”整套经历提纲。例如选了协作中的分工，就只问“你和同事如何划分这项工作的职责？”，其他角度留待后续。不附参考答案，不预设候选人做过未提供的方案。
${INTERVIEW_QUESTION_RULES}
${SERIES_CONTEXT_RULES}
输出 JSON：{"question": "题目文本"}。只返回 question 字段，不得添加其他键；只输出 JSON。`;

export function buildSeriesAdvanceMessages(params: {
  roundNo: number;
  jd: string;
  resumeContext: string;
  priorParts: readonly PromptPart[];
}): SafeMessage[] {
  return [{
    role: "user",
    parts: [
      { trust: "trusted", text: "【当前轮次】\n" },
      { trust: "untrusted", tag: "interview_round", text: String(params.roundNo) },
      { trust: "trusted", text: "\n\n【岗位要求】\n" },
      { trust: "untrusted", tag: "job_description", text: params.jd },
      { trust: "trusted", text: "\n\n【候选人简历】\n" },
      { trust: "untrusted", tag: "candidate_resume", text: params.resumeContext },
      ...params.priorParts,
      { trust: "trusted", text: "\n\n请出第一道面试题。" },
    ],
  }];
}

export function parseSeriesAdvanceQuestion(raw: string, priorQuestionKeys: ReadonlySet<string> = new Set()): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelProtocolError("AI 没有生成有效题目，请重试");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "question")) {
    throw new ModelProtocolError("AI 出题结果包含未声明字段");
  }
  const question = validateInterviewQuestion((parsed as { question?: unknown }).question);
  if (priorQuestionKeys.has(questionComparisonKey(question))) {
    throw new ModelProtocolError("AI 首题与本进阶面试的前轮原题重复，请重试");
  }
  return question;
}
