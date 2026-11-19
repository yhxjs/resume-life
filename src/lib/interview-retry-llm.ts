import { INTERVIEW_ANSWER_OUTPUT_LIMITS } from "@/lib/model-protocol";
import { ANSWER_SCORING_RULES, FOLLOWUP_CONTEXT_RULES, REFERENCE_ANSWER_RULES } from "@/lib/prompt-guidelines";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";

export const RETRY_EVAL_PROMPT = `你是严格且专业的面试官。候选人针对面试中曾经回答过的一道题目进行了「重新作答」，请对本次最新回答进行评分与点评。
先按题干确定必需能力，只从“本次重新作答内容”提取证据写评分与 comment，最后另行写 reference。技术不足须对应使原答在已给条件下不能成立的机制缺口；单一实现的步骤或参数不自动成为必答，已给约束未给数值不等于缺约束。可行替代同等接受；只列名词而未解释必要机制仍可指出。可选展开与不足分开，不借原答或历史补分。只输出一个 JSON 对象，字段固定为 depth、structure、authenticity、completeness、comment、reference；每个键仅出现一次：
- 四个评分字段分别为0-10整数，没有默认分数。
- comment 直接评价本次回答已提供的有效内容或尚缺的必要解释，判断落在回答内容上；需要区分含义时才引用原句，不为引文另造候选人状态的概括。历史状态只用于理解背景，不能写成本次已说明的优点。通常2-3句，简短且充分时可更短，不为句数重复评分理由，最多 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.comment} 字符。
- reference 为本题作答参考字符串。写作前重新从原始材料确定相关项目，按下方事实组规则形成完整事实段，不以 comment 选出的评分证据代替事实组；优先沿用仍有效的原事实分句，未知信息单列待补，之后再给条件式方法。最多 ${INTERVIEW_ANSWER_OUTPUT_LIMITS.reference} 字符；篇幅不足先缩方法，不缩事实限定，不预设分数。
指代或方案目标缺失时，reference 也保持该信息待补，先澄清对象与目标，再按目标选择方法；JD 和经历背景不能代选。若给具体场景示例，须把场景目标和适用条件一并明确设为假设，条件句仅覆盖其中实际写出的条件。
四维的含义与评分标准统一遵循下方评分校准，不另设模板完整性要求。
${ANSWER_SCORING_RULES}
${REFERENCE_ANSWER_RULES}
${FOLLOWUP_CONTEXT_RULES}
比较仅描述两次原答明确表达的同一事实及具体差异；一方未提及的状态不补成一致，不推导能力变化或为重答提分。未提供原答时不比较进步。补充说明归入 comment 或 reference，字段外不另加键；精简时保留完整句意，不截断句尾。只输出 JSON。`;

export function buildInterviewRetryMessages(params: {
  jd: string;
  resumeContext: string;
  followupParts: PromptPart[];
  turn: { idx: number; question: string };
  priorAnswer: string;
  answer: string;
}): SafeMessage[] {
  const parts: PromptPart[] = [
    { trust: "trusted", text: "【岗位要求 JD】\n" },
    { trust: "untrusted", tag: "job_description", text: params.jd || "（通用岗位）" },
    { trust: "trusted", text: "\n\n【候选人简历背景】\n" },
    { trust: "untrusted", tag: "candidate_resume", text: params.resumeContext },
    ...params.followupParts,
    { trust: "trusted", text: "\n\n【面试题】\n" },
    { trust: "untrusted", tag: "interview_question", text: JSON.stringify(params.turn) },
  ];
  if (params.priorAnswer) {
    parts.push(
      { trust: "trusted", text: "\n\n【原回答（供对比参考）】\n" },
      { trust: "untrusted", tag: "prior_candidate_answer", text: params.priorAnswer },
    );
  }
  parts.push(
    { trust: "trusted", text: "\n\n【本次重新作答内容】\n" },
    { trust: "untrusted", tag: "candidate_answer", text: params.answer },
  );
  return [{ role: "user", parts }];
}
