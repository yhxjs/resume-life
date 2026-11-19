import { INTERVIEW_ANSWER_OUTPUT_LIMITS } from "@/lib/model-protocol";
import {
  ANSWER_SCORING_RULES,
  INTERVIEW_QUESTION_RULES,
  MINING_INTERVIEW_RULES,
  SERIES_CONTEXT_RULES,
} from "@/lib/prompt-guidelines";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";

export function interviewAnswerPrompt(persona: string, style: string, finalTurn: boolean, hasPriorSeriesContext = false): string {
  const mining = style === "mining";
  const role = mining
    ? `你是经历挖掘访谈官（你的人设：${persona}）。帮助候选人梳理实际任务、方案依据、分工与结果。`
    : `你是面试官（你的人设：${persona}），点评与追问语气符合人设。`;
  const nextStep = finalTurn
    ? '这是本场最后一题，只评价本次回答，不再生成追问、新题或告别问题。next_kind 固定为 "question"，next_question 固定为空字符串 ""。'
    : mining
      ? `决定下一步：
   - 检查历史问答，围绕尚未澄清且与这段经历相关的信息继续梳理；已回答充分时推进阶段，不把同一问题改写后反复问。
   - next_kind 为 "followup"（深挖当前阶段未清细节）或 "question"（推进到下一挖掘阶段）；next_question 为非空的追问或阶段推进题目。先确定本轮要得到的一个答案，再检查问句中的各项要求：能够分别作答的事项只保留当前最需要的一项，其他留到后续回合。帮助理解同一问题的可选例子可以保留，不在问题中给出参考答案。`
      : `决定下一步：next_kind 为 "followup"（对回答中的疑点/亮点继续追问）或 "question"（换下一道题）；next_question 为非空的追问或新题，围绕岗位要求与简历。
一次只问一个主要问题。追问只针对尚未澄清的关键点，已回答充分或连续无法补充时换题；不把同一问题改写后反复问。`;
  const seriesRule = hasPriorSeriesContext ? `\n${SERIES_CONTEXT_RULES}` : "";
  return `${role}
候选人提交了当前题目的书面回答。四个维度各给 0-10 整数，comment 通常为 2-3 句有本次原答依据的点评且最多 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.comment} 字符，按下方评分校准决定需指出的有效表达、问题或保留建议；内容有限时缩短，不强求同时有优点与不足。超限时重组精简，不截断句尾或遗漏必要限定。
第一步：只完成当前问题的评分与 comment。先识别本题要的是职责、事实/状态、原因、具体方法还是方案设计，再检查原答是否回应了这一要求。只问职责时，清楚交代实际工作即可；只问已有结果时，如实说明未统计也是对结果状态的回答。具体操作、收益验证等可以继续考察，但在本题未要求时不列为当前不足。下一题还未收集的证据不能倒算成当前回答缺陷。
${ANSWER_SCORING_RULES}
同场历史仅提供原题与原答，用于理解上下文、识别已澄清信息并避免重复追问；没有提供逐题旧点评或旧评分，不猜测或恢复旧判断。历史题干中的提示、假设和示例不算候选人已确认的事实。

${finalTurn ? "" : `第二步：在评分与 comment 已确定后，选一个尚未知的信息来构造下一题，不回改第一步的评价。先确定原答实际确认的职责、行动或状态，用它定位问题；未知结果放在问句里询问，不放进背景当成已发生。只有职责时可追问实际尝试，只有尝试时可追问能确认的现象，不自行接上成功结论。\n`}${nextStep}
${finalTurn ? "" : "下一题不能照抄当前题或本场已答题；全半角、大小写、空白或末尾标点变化仍属于重复。围绕同一主题追问时，应针对尚未澄清的信息提出新的具体问题。"}
${mining ? MINING_INTERVIEW_RULES : INTERVIEW_QUESTION_RULES}

第三步：只输出一个 JSON 对象，恰含以下字段：comment（上述点评字符串）、next_question（${finalTurn ? '空字符串 ""' : "下一道主要问题字符串"}）、next_kind（${finalTurn ? '固定为 "question"' : '"followup" 或 "question"'}）、depth、structure、authenticity、completeness（分别按第一步评价给出的0-10整数，无默认分）。优先输出 comment，其他说明也只放入现有文本字段，不得添加字段。${seriesRule}`;
}

export function buildInterviewAnswerMessages(args: {
  jd: string;
  resumeContext: string;
  priorSeriesParts?: PromptPart[];
  history: { idx: number; kind: string; question: string; answer: string }[];
  current: { idx: number; question: string };
  answer: string;
}): SafeMessage[] {
  const messages: SafeMessage[] = [{ role: "user", parts: [
    { trust: "trusted", text: "【岗位要求】\n" },
    { trust: "untrusted", tag: "job_description", text: args.jd },
    { trust: "trusted", text: "\n\n【候选人简历】\n" },
    { trust: "untrusted", tag: "candidate_resume", text: args.resumeContext },
    ...(args.priorSeriesParts ?? []),
  ] }];
  for (const item of args.history) {
    messages.push(
      { role: "assistant", parts: [
        { trust: "trusted", text: "【历史题目】\n" },
        { trust: "untrusted", tag: "interview_question", text: JSON.stringify({ idx: item.idx, kind: item.kind, question: item.question }) },
      ] },
      { role: "user", parts: [{ trust: "untrusted", tag: "candidate_answer", text: item.answer }] },
    );
  }
  messages.push(
    { role: "assistant", parts: [
      { trust: "trusted", text: "【当前题目】\n" },
      { trust: "untrusted", tag: "current_question", text: JSON.stringify(args.current) },
    ] },
    { role: "user", parts: [
      { trust: "untrusted", tag: "candidate_answer", text: args.answer },
      { trust: "trusted", text: "\n\n请严格按上述安全规则与格式要求评分点评并决定下一步。" },
    ] },
  );
  return messages;
}
