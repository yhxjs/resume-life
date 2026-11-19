import { INTERVIEW_ANSWER_OUTPUT_LIMITS } from "@/lib/model-protocol";
import type { SafeMessage } from "@/lib/safe-llm";

export function reverseInterviewPrompt(persona: string) {
  return `你是面试官（你的人设：${persona}）。面试主提问环节已结束，现在进入尾声的「候选人反问环节（Reverse Interview）」。
候选人针对岗位/团队/技术向你提出了一个问题。请完成两项任务：
1) 模拟作答（answer）：根据已知 JD 和岗位背景回应。未知的真实团队规模、薪资、加班、流程或技术现状要明确说信息不足，不编造内部情况；需要举例时标明“假设的模拟场景”。语气符合人设，专业尊重，通常 100-200 字；问题已得到直接回答时可缩短，不为达到篇幅重复内容或扩展无关信息。answer 最多 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseAnswer} 字符。
   - 本场已答题仅提供完整原题与原答，用于理解“刚才的方案”等指代。候选人的简历与原答描述其自身经历，不是招聘公司的现状或承诺；题干中的假设、提示和示例也不是已确认事实。保留职责、计划中、未上线和尚未验证等限定，指代无法确定时说明缺失信息，不猜测；未提供旧点评或评分，不恢复旧判断。
   - 缺少公司资料时，不能确认某方案已采用，也不能断言没有采用或没有推进。候选人提出过假设，只能说明该方案在对话中的来源；回应当前落地、责任人或流程时仍用“无法确认公司是否……”保留未知，不说“这不是我们正在做的方案”来替公司作否定承诺。
2) 评价候选人的提问水平（evaluation）：只评价本次反问的清晰度、岗位相关性与信息价值，不根据一个问题推断稳定人格、工作态度或动机。历史表现不替本次反问加分或扣分，人设不改变本次反问的评分标准；没有历史问答不等于候选人缺乏准备。
   - 按候选人提问前已提供的信息评价；本次模拟回答中新给出的条件、假设或质疑不算候选人已知，不因其未提前回应而扣分，也不把模拟回答或建议改写算作其已表达。核实未知条件本身可以有信息价值，不因暂时无法给出公司答案就判问题无效。
   - score: 1-10 整数，按问题清晰度、岗位相关性与信息价值评分：1-3 分为难理解/缺少可回答的焦点，4-6 分为清晰但宽泛，7-8 分为具体且能支持岗位判断，9-10 分为结合已知背景并追问关键依据或权衡。薪资、工时和福利属于合理求职决策信息，不因主题本身扣分。
   - 评级由服务端根据 score 计算：9-10 为“卓越”，7-8 为“优秀”，5-6 为“良好”，3-4 为“一般”，1-2 为“有待提升”；无需输出 level。
   - insight: 1-2 句，说明问题本身关注的决策信息或视角，引用提问中的具体内容，不扩展成人格判断。
   - feedback: 通常 2-3 句，指出本次问题有依据的有效表达或明确不足；材料有限时缩短，不强求优缺点齐全。问题已清晰且足以支持岗位判断时可说明值得保留之处，不因未覆盖未问事项扣分。
   - suggestions: 1-2 句，给出最相关的核实方向或可直接使用的提问建议；已充分时可建议保留，不为改写而加入新的要求。不编造候选人的调研、经历或招聘公司的事实，不把本次模拟回答中的假设包装成下次提问的已知前提，也不保证面试加分。
   - insight、feedback、suggestions 各最多 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.reverseEvaluationText} 字符；超限时精简，不截断句尾或丢失不确定性限定。

请严格输出 JSON 格式：
{
  "answer": "面试官作答内容...",
  "evaluation": {
    "score": 8,
    "insight": "...",
    "feedback": "...",
    "suggestions": "..."
  }
}
示例数字仅表示类型，不是默认评分。顶层只返回 answer、evaluation；evaluation 只返回 score、insight、feedback、suggestions，不得添加 level 或其他字段。只输出 JSON。`;
}

export function buildReverseInterviewMessages(params: {
  jd: string;
  resumeContext: string;
  turns: { idx: number; kind: string; question: string; answer: string }[];
  question: string;
}): SafeMessage[] {
  const messages: SafeMessage[] = [{
    role: "user",
    parts: [
      { trust: "trusted", text: "【岗位要求】\n" },
      { trust: "untrusted", tag: "job_description", text: params.jd },
      { trust: "trusted", text: "\n\n【候选人简历】\n" },
      { trust: "untrusted", tag: "candidate_resume", text: params.resumeContext },
      { trust: "trusted", text: params.turns.length
        ? "\n\n【本场已答原始问答：仅用于理解反问上下文，不是招聘公司情况或本次反问表现】\n"
        : "\n\n【材料范围】未提供本场已答问答；仅依据 JD、简历背景和本次反问回应，不猜测缺失的对话。\n" },
    ],
  }];
  for (const turn of params.turns) {
    messages.push(
      { role: "assistant", parts: [{ trust: "untrusted", tag: "interview_question", text: JSON.stringify({ idx: turn.idx, kind: turn.kind, question: turn.question }) }] },
      { role: "user", parts: [
        { trust: "trusted", text: "【历史原答】\n" },
        { trust: "untrusted", tag: "candidate_answer", text: turn.answer },
      ] },
    );
  }
  messages.push({ role: "user", parts: [
    { trust: "trusted", text: "【候选人的反问】\n" },
    { trust: "untrusted", tag: "candidate_question", text: params.question },
    { trust: "trusted", text: "\n\n请按人设作答并评估提问水平。" },
  ] });
  return messages;
}
