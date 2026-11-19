import { INTERVIEW_ANSWER_OUTPUT_LIMITS } from "@/lib/model-protocol";
import { FOLLOWUP_CONTEXT_RULES, REFERENCE_ANSWER_RULES } from "@/lib/prompt-guidelines";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";

export const INTERVIEW_REFERENCE_PROMPT = `你是面试辅导教练。请基于岗位要求、简历背景、原问题和候选人的回答，生成一份针对该题的练习参考答案。
要求：
1. 按题干组织知识解释、假设情境下的处理思路或真实经历表达，不强求 STAR、技术选型或数据成果；
2. 只使用已知岗位要求，不猜测公司的内部标准；尚未作答时可给出知识讲解、假设思路或明确待补充的经历框架，不冒充候选人原答，也不声称比原答更好；
3. 相关真实经历先选出仍有效的原事实分句，优先沿用短句写完整事实段，再给方法；职责、排他范围、权限和完成、验证、发布、收益状态分别保留，不用职责改写权限，不因题目问方法而省去已知状态。未知仍待补，无实践不推断不会；指代或目标缺失时先澄清，JD 与简历背景不能代选，具体示例须连目标一起设为假设。背景不算本题已答，不恢复未提供的旧点评、旧评分或旧参考答案，不把 JD 要求补成个人事实；
4. 输出格式为 JSON：
{
  "reference": "针对本题的参考答案或待补充框架，可用段落换行增强可读性；假设与未知事实须明确标注"
}
reference 最多 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.reference} 字符。材料有限时缩短，不因示范效果扩写；超限先缩方法与重复说明，保留原事实分句的限定和完整句意，不截断句尾。
${REFERENCE_ANSWER_RULES}
${FOLLOWUP_CONTEXT_RULES}
将需要的说明都放在 reference 字符串内；字符串结束后直接关闭对象，不另加注释字段、空键或值为 null 的字段。最终 JSON 对象恰有 reference 一个字段。`;

export function buildInterviewReferenceMessages(params: {
  jd: string;
  resumeContext: string;
  followupParts: PromptPart[];
  turn: { idx: number; question: string };
  answer: string;
}): SafeMessage[] {
  return [{
    role: "user",
    parts: [
      { trust: "trusted", text: "【岗位要求 JD】\n" },
      { trust: "untrusted", tag: "job_description", text: params.jd || "（通用岗位）" },
      { trust: "trusted", text: "\n\n【候选人简历背景】\n" },
      { trust: "untrusted", tag: "candidate_resume", text: params.resumeContext },
      ...params.followupParts,
      { trust: "trusted", text: "\n\n【面试题目】\n" },
      { trust: "untrusted", tag: "interview_question", text: JSON.stringify(params.turn) },
      { trust: "trusted", text: "\n\n【候选人原答】\n" },
      { trust: "untrusted", tag: "candidate_answer", text: params.answer || "（尚未作答）" },
    ],
  }];
}
