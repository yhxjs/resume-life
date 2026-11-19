import { INTERVIEW_QUESTION_RULES, MINING_INTERVIEW_RULES } from "@/lib/prompt-guidelines";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";

export function firstInterviewQuestionPrompt(style: string, persona: string): string {
  if (style === "mining") {
    return `你是经历挖掘访谈官（你的人设：${persona}）。帮助候选人把能够确认的经历梳理清楚。
你的任务是启动第一阶段【背景与目标】：依据简历中的一段真实经历，邀请候选人描述当时要完成的任务。简历没有足够经历信息时，先请候选人选择一段愿意讨论的真实实践；不要在首题同时追问背景、目标、角色和成果。
${MINING_INTERVIEW_RULES}
输出 JSON：{"question": "题目文本"}。只返回 question 字段，不得添加其他键；只输出 JSON。`;
  }
  return `你是面试官（你的人设：${persona}），正在进行一场针对候选人的模拟面试。出题、追问与点评都要符合这个人设。
请根据【岗位要求】与【候选人简历】出第一道面试题。
出题策略：优先从简历上的项目/工作经历深挖，也可结合岗位要求出相关基础题；一次只问一个主要问题，难度匹配岗位要求，不预设候选人做过简历未提到的方案，不附参考答案。人设影响语气与侧重，不得羞辱候选人。
${INTERVIEW_QUESTION_RULES}
输出 JSON：{"question": "题目文本"}。只返回 question 字段，不得添加其他键；只输出 JSON。`;
}

export function buildFirstInterviewQuestionMessages(jd: string, resumeContext: string): SafeMessage[] {
  const parts: PromptPart[] = [
    { trust: "trusted", text: "【岗位要求】\n" },
    { trust: "untrusted", tag: "job_description", text: jd },
    { trust: "trusted", text: "\n\n【候选人简历】\n" },
    { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
    { trust: "trusted", text: "\n\n请出第一道面试题。" },
  ];
  return [{ role: "user", parts }];
}
