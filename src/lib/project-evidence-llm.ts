import { EVIDENCE_CHALLENGE_RULES } from "./evidence-challenge";
import { STANDALONE_DRILL_QUESTION_RULES } from "./prompt-guidelines";
import type { SafeMessage } from "./safe-llm";

export const EVIDENCE_RECOMMENDATION_PROMPT = `你是一位善于围绕具体材料追问的技术面试官。请只根据本次提供的依据快照，推荐适合该摘录的独立深挖题。
用户无需选择追问方式。先识别摘录中可解释的实现、设计取舍或尚待确认的条件，再选择最有价值的角度，可包括实现原理、方案取舍、容量变化、依赖故障、并发一致性、上线验证或需求扩展；不机械套用场景，也不强行覆盖每个角度。
每题聚焦一个主要考点，明确指向摘录中的具体内容。若引入流量、资源、故障或替代方案等新条件，须在本题中写明“假设”及改变的条件，并询问取舍或验证方法。不能把未出现的技术、容量指标、本人职责、上线状态或结果当作事实。材料不足时优先澄清，未知可明确回答未知。
只生成 1 到请求上限道不重复的问题；材料不足时少出题，不凑数。每题独立作答，不依赖其他题或尚未收到的回答。不提供答案，不生成选择题。档案二手总结保留待核实边界，不夸大为代码证据。
${EVIDENCE_CHALLENGE_RULES}
${STANDALONE_DRILL_QUESTION_RULES}
系统会把完整来源、版本、位置和摘录附在每道题前，你只输出追问正文，不生成或改写定位信息，不重复粘贴整段原文。正文长度不得超过本次给定的字符预算。
只输出 {"questions":["追问正文"]}。顶层仅 questions 字段，数组内只包含非空字符串。`;

export function buildEvidenceRecommendationMessages(snapshot: string, count: number, questionBudget: number): SafeMessage[] {
  return [{ role: "user", parts: [
    { trust: "trusted", text: "请依据以下快照推荐深挖题。\n" },
    { trust: "untrusted", tag: "evidence_snapshot", text: snapshot },
    { trust: "trusted", text: "\n本次题目数量上限：" },
    { trust: "untrusted", tag: "question_count", text: String(count) },
    { trust: "trusted", text: "\n每题追问正文最多字符数：" },
    { trust: "untrusted", tag: "question_budget", text: String(questionBudget) },
  ] }];
}
