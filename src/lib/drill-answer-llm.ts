import { DRILL_EVALUATION_OUTPUT_LIMITS } from "@/lib/model-protocol";
import { ANSWER_SCORING_RULES, PROJECT_INTERVIEW_CONTEXT_RULES, PROJECT_INTERVIEW_TABLE_DOCUMENT_RULES, REFERENCE_ANSWER_RULES, REFERENCE_FACT_GROUP_RULES } from "@/lib/prompt-guidelines";
import { hasQuestionContent } from "@/lib/question-normalization";
import { validateGeneratedScores } from "@/lib/scores";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";
import { projectInterviewContextHasTableDocument } from "./project-interview-context";
import { EVIDENCE_CHALLENGE_RULES } from "./evidence-challenge";

const DRILL_OUTPUT_RULES = `只输出一个 JSON 对象，恰含以下六个字段：
- depth、structure、authenticity、completeness：各为 0 到 10 的整数，分别依据本次原答确定，不提供示例分数或默认分。技术依据薄弱不自动等于表达混乱或事实矛盾；给任一维度低分时，应有该维度自己的证据，不能将同一个技术缺口复制成四维清零。
- comment：非空字符串，依据本次原答给具体点评，通常2-4句；简短且充分时可更短，不为句数重复评分理由，最多 ${DRILL_EVALUATION_OUTPUT_LIMITS.comment} 字符。
- reference：非空字符串，按参考答案边界及本次入口的组织规则生成。内容充分时可短于原答，不追加常规流程，最多 ${DRILL_EVALUATION_OUTPUT_LIMITS.reference} 字符。
按上述字段名返回 JSON，不输出字段说明或类型名称，不得添加其他字段。reference 字符串结束后直接关闭对象；补充说明写在现有文本字段内，不另加备注或空键。`;

const DRILL_SCOPE_RULES = `输出前按题目范围复核评分与 comment：每项不足必须对应本题必要要求，不能只是 reference 比原答多出的步骤。
- 将每项不足与评分前确定的必要要求核对；未被询问且不影响已给条件下核心机制成立的生产细节，只作可选拓展。不要先列完整方案，再据此寻找原答遗漏。
- 原答纠正了题干错误的既往经历前提时，依据纠正后的实际职责与已给解释评价。“已做过某事后如何验证”的错误前提被纠正，并不自动变成“假设今后实施，你会如何验证”的新题。后者只能是明确可选的参考练习，不作为本题不足或扣分理由。
- 经历题的 reference 先整理已有事实，不沿着常见工作流程续写下一步。逐一核对其中的动作：该动作及其执行者须在原答或明确对应材料中有依据，合理但未提供的动作只能删去或作为明确可选的建议，不能写成已发生。
- 每个采用的事实带上适用的个人/他人分工、完成与发布状态、收益是否验证等限定；“参与”仍写参与，不升级为负责。最后逐一核对待补充项，只列真正未知的信息，已给出的状态不重复询问，已知“未发布”也不改成“是否发布待核实”。`;

const PROJECT_EVAL_ARCHIVE_CONFLICT_RULES = `项目档案与材料对同一职责或指标冲突，且没有明确更正、撤回或替代关系时，两方都保持待核；当前访谈或原始材料的一方较新、较具体，或被候选人在回答中重复，都不单独构成更正。评分和comment不得把任一方称为已确认或已纠正；指出来源冲突但不据此判候选人说谎。reference并列档案与材料各自说法并标待核。指标仅见于档案时，材料未说明是否测量不等于未测量，也不等于已验证。`;

const PROJECT_EVAL_COMMENT_FIDELITY_RULES = `comment只评价原答实际表达或遗漏的内容；不要把题目、档案、材料或rubric中的事实归给原答。描述遗漏时，应确认该信息确实未出现在原答中。`;

const PROJECT_EVAL_COMMENT_QUOTE_GUARD_RULES = `comment直接引用原答时，引用必须是原答中的逐字内容；不得把题目或背景出现的数字、结论改写成原答说法。某信息未在原答出现时，明确写“原答未提及该信息”，不要说原答对它只给出某种说明。`;

const PROJECT_EVAL_REFERENCE_CONSISTENCY_RULES = `reference全文须一致保留来源和状态边界：对没有明确更正的职责冲突，任何位置都不能单独把档案或材料一方写成已知分工，只能并列来源并标待核；材料只表示未说明是否有测量记录时，只写需核实记录是否存在及其来源。不得把“未说明/未列出是否有记录”改写成“没有、未提供或未发现记录”，也不得用“如果尚无记录”等条件句推演记录缺失后的答法。只有材料明确确认记录缺失时，才可说记录缺失；即使如此也不能据此推断指标从未测量、尚未统计或需要补测。`;

const PROJECT_EVAL_CONFLICT_COMMENT_RULES = `原答只采用档案或材料一方说法，不等于澄清、纠正或解决来源冲突。comment应准确指出原答采用了哪一方的说法但未处理另一方冲突，不称其已澄清职责。`;

const PROJECT_EVAL_REFERENCE_SCOPE_RULES = `

【明确分工对照的事实组范围】
当同一项目的明确更正将本人职责与他人负责的事项并列，用于界定个人工作范围时，这项对照属于本题相关事实组。即使题目只问其中一项工作的具体方法，reference也简短保留对方分工，以及更正明确关联的完成、发布和收益状态；不要因此带入同项目中独立且与题目无关的工作。
若本题回答或同一项目更正明确使用“只／仅／未参与”等排他限定，reference应以等义措辞保留该职责范围，不能弱化为只描述某项正向动作。`;

export const PROJECT_EVAL_PROMPT = `你是面试官。候选人针对项目面试题提交了书面回答，请依据题目范围评分。
${EVIDENCE_CHALLENGE_RULES}
${ANSWER_SCORING_RULES}
${REFERENCE_ANSWER_RULES}
${PROJECT_INTERVIEW_CONTEXT_RULES}
${PROJECT_EVAL_ARCHIVE_CONFLICT_RULES}
${PROJECT_EVAL_COMMENT_FIDELITY_RULES}
${PROJECT_EVAL_COMMENT_QUOTE_GUARD_RULES}
${PROJECT_EVAL_REFERENCE_CONSISTENCY_RULES}
${PROJECT_EVAL_CONFLICT_COMMENT_RULES}
${DRILL_SCOPE_RULES}
完成原答评分后再组织 reference：知识题只给本题必要解释，假设题保持条件与假设语气。涉及实际项目时，从本次原答及同一项目明确更正中选出有关事实组，先写完整事实段，再接待补项或条件式方法。背景不算本次已答内容，不新增技术考点；常见检查步骤只能作为可选方法，不能续写成第一人称已做动作。所有说明只写入 comment 或 reference。
${REFERENCE_FACT_GROUP_RULES}
${DRILL_OUTPUT_RULES}${PROJECT_EVAL_REFERENCE_SCOPE_RULES}`;

export const BANK_EVAL_PROMPT = `你是面试官。候选人针对岗位通用面试题或模拟面试追练题提交了书面回答，请依据题目范围评分。
岗位背景用于理解题意、适用条件和组织参考答案，不代表候选人已经展示相应经验；不能据此替本次原答补分，也不将题干未要求的岗位条件列为回答遗漏。
${ANSWER_SCORING_RULES}
${REFERENCE_ANSWER_RULES}
${DRILL_SCOPE_RULES}
${DRILL_OUTPUT_RULES}`;

export function buildDrillEvaluation(params: {
  isBankDrill: boolean;
  direction: string;
  jd: string;
  projectContext: string;
  question: string;
  answer: string;
}): { systemPrompt: string; messages: SafeMessage[] } {
  const isBankDrill = params.isBankDrill;
  const contextParts: PromptPart[] = [];
  if (isBankDrill) {
    contextParts.push({ trust: "trusted", text: "【岗位背景】\n" });
    if (params.direction) contextParts.push(
      { trust: "trusted", text: "方向：" },
      { trust: "untrusted", tag: "job_direction", text: params.direction },
    );
    if (params.direction && params.jd) contextParts.push({ trust: "trusted", text: "\n" });
    if (params.jd) contextParts.push(
      { trust: "trusted", text: "JD：" },
      { trust: "untrusted", tag: "job_description", text: params.jd },
    );
    if (!params.direction && !params.jd) contextParts.push({ trust: "trusted", text: "（未提供）" });
  } else {
    contextParts.push(
      { trust: "trusted", text: "【项目档案】\n" },
      { trust: "untrusted", tag: "project_context", text: params.projectContext },
    );
    if (projectInterviewContextHasTableDocument(params.projectContext)) {
      contextParts.push({ trust: "trusted", text: PROJECT_INTERVIEW_TABLE_DOCUMENT_RULES });
    }
  }
  return {
    systemPrompt: isBankDrill ? BANK_EVAL_PROMPT : PROJECT_EVAL_PROMPT,
    messages: [{ role: "user", parts: [
      ...contextParts,
      { trust: "trusted", text: "\n\n【面试题】\n" },
      { trust: "untrusted", tag: "interview_question", text: params.question },
      { trust: "trusted", text: "\n\n【候选人回答】\n" },
      { trust: "untrusted", tag: "candidate_answer", text: params.answer },
    ] }],
  };
}

export function validateDrillEvaluation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Record<string, unknown>;
  const allowedFields = new Set(["depth", "structure", "authenticity", "completeness", "comment", "reference"]);
  if (Object.keys(parsed).some(key => !allowedFields.has(key))) return null;
  const scores = validateGeneratedScores(parsed);
  if (!scores || typeof parsed.comment !== "string" || !hasQuestionContent(parsed.comment)
    || typeof parsed.reference !== "string" || !hasQuestionContent(parsed.reference)
    || parsed.comment.length > DRILL_EVALUATION_OUTPUT_LIMITS.comment
    || parsed.reference.length > DRILL_EVALUATION_OUTPUT_LIMITS.reference) return null;
  return { scores, comment: parsed.comment, reference: parsed.reference };
}
