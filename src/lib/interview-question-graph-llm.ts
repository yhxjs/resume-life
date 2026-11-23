import { INTERVIEW_QUESTION_RULES, MINING_INTERVIEW_RULES } from "@/lib/prompt-guidelines";
import { interviewStyleOf, type InterviewStyleKey } from "@/lib/interview";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";
import {
  INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS,
  INTERVIEW_QUESTION_GRAPH_LABEL_MAX_CHARS,
  INTERVIEW_QUESTION_GRAPH_MAX_DEPTH,
  type InterviewQuestionGraphFrontier,
} from "@/lib/interview-question-graph";

export type InterviewQuestionGraphAction = "start" | "expand" | "predict";

export function interviewQuestionGraphPrompt(style: InterviewStyleKey, action: InterviewQuestionGraphAction): string {
  const persona = interviewStyleOf(style).persona;
  const task = action === "start"
    ? "先提出一道主要问题，再给出两种可能的候选人回答方向及各自的一道追问。"
    : action === "expand"
      ? "为给定的每道待扩展问题，给出两种可能的候选人回答方向及各自的一道追问。"
      : "为给定的第三层问题给出两种候选人可能回答，只生成预测回答，不生成追问或其他问题。";
  const responseShape = action === "start"
    ? '{"question":"...","branches":[{"label":"...","predicted_answer":"...","followup_question":"..."},{"label":"...","predicted_answer":"...","followup_question":"..."}]}'
    : action === "expand"
      ? '{"expansions":[{"question_id":"输入 ID","branches":[{"label":"...","predicted_answer":"...","followup_question":"..."},{"label":"...","predicted_answer":"...","followup_question":"..."}]}]}'
      : '{"predictions":[{"question_id":"输入 ID","answers":[{"label":"回答具体且有依据","predicted_answer":"..."},{"label":"回答概括或信息不足","predicted_answer":"..."}]}]}';
  const scope = action === "start"
    ? "只生成一道根题。"
    : action === "expand"
      ? "只扩展给定题目，不新增根题；question_id 必须逐字照抄输入 ID。"
      : "只为给定的第三层题目生成回答；question_id 必须逐字照抄输入 ID，禁止返回 followup_question、追问或新题目。";
  const branchRules = action === "predict"
    ? "每个问题必须恰有两条预测回答，响应中不能出现任何追问字段。"
    : `分支必须恰有两条，题目深度最多 ${INTERVIEW_QUESTION_GRAPH_MAX_DEPTH} 层；每次只生成下一层。本次生成的所有题目之间也不得重复。`;
  const answerGuidance = "输出用于面试官视角的练习图谱，不是真实候选人的回答记录。每条预测回答写成 1–3 句候选人可能说出的练习示例，不要只写作答建议；内容只能引用简历确实写明的事实。简历没有提供的职责、过程、数据或结果必须明确标成待确认或假设，不得替候选人编造经历。";
  const questionGuidance = action === "predict"
    ? "只生成候选人回答示例，不要新增任何问题、追问或分支。"
    : "两条分支分别体现回答具体且有依据、回答概括或关键信息不足。每个追问只问一个主要问题，须依据对应回答继续核实或深入，不得重复主问题。";
  const questionRules = action === "predict"
    ? ""
    : `题干事实与追问边界：\n${INTERVIEW_QUESTION_RULES}\n${style === "mining" ? MINING_INTERVIEW_RULES : ""}`;

  return `你是模拟面试的命题官，面试官风格为：${persona}。
${task}
${answerGuidance}${questionGuidance}
${questionRules}
${scope}
只输出严格 JSON，不要 Markdown，不得添加未声明字段。
${responseShape}
${branchRules}label 最多 ${INTERVIEW_QUESTION_GRAPH_LABEL_MAX_CHARS} 字符，predicted_answer 最多 ${INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS} 字符。`;
}

export function buildInterviewQuestionGraphMessages(args: {
  action: InterviewQuestionGraphAction;
  jd: string;
  resumeContext: string;
  frontier?: readonly InterviewQuestionGraphFrontier[];
  knownQuestions?: readonly string[];
}): SafeMessage[] {
  const parts: PromptPart[] = [
    { trust: "trusted", text: "【岗位要求】\n" },
    { trust: "untrusted", tag: "job_description", text: args.jd },
    { trust: "trusted", text: "\n\n【候选人简历】\n" },
    { trust: "untrusted", tag: "candidate_resume", text: args.resumeContext },
  ];
  if (args.knownQuestions?.length) {
    parts.push({ trust: "trusted", text: "\n\n【图谱中已有题目：仅用于避免重复】\n" });
    args.knownQuestions.forEach((question, index) => {
      parts.push(
        { trust: "trusted", text: `题目 ${index + 1}：` },
        { trust: "untrusted", tag: "known_interview_question", text: question },
        { trust: "trusted", text: "\n" },
      );
    });
  }
  if (args.action !== "start") {
    parts.push({ trust: "trusted", text: args.action === "expand" ? "\n\n【待扩展题目】\n" : "\n\n【待生成预测回答的题目】\n" });
    for (const item of args.frontier ?? []) {
      parts.push(
        { trust: "trusted", text: "题目 ID：" },
        { trust: "untrusted", tag: "frontier_question_id", text: item.question_id },
        { trust: "trusted", text: "\n上级问题：" },
        { trust: "untrusted", tag: "parent_interview_question", text: item.parent_question },
        { trust: "trusted", text: "\n候选人回答方向：" },
        { trust: "untrusted", tag: "predicted_answer_scenario", text: item.answer_scenario },
        { trust: "trusted", text: "\n本轮问题：" },
        { trust: "untrusted", tag: "frontier_interview_question", text: item.question },
        { trust: "trusted", text: "\n" },
      );
    }
  }
  parts.push({ trust: "trusted", text: args.action === "start" ? "\n请生成根题与第一层回答分支。" : args.action === "expand" ? "\n请只扩展待扩展题目。" : "\n请只生成这些第三层题目的预测回答，不生成追问。" });
  return [{ role: "user", parts }];
}
