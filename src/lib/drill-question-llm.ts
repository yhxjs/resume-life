import { INTERVIEW_QUESTION_RULES, PROJECT_INTERVIEW_CONTEXT_RULES, PROJECT_INTERVIEW_TABLE_DOCUMENT_RULES, STANDALONE_DRILL_QUESTION_RULES } from "@/lib/prompt-guidelines";
import { bankKindLabel, type BankEntry } from "@/lib/bank";
import type { PromptPart, SafeMessage } from "@/lib/safe-llm";
import { projectInterviewContextHasTableDocument } from "./project-interview-context";

/** 数据库加载与合成评测共用记录编码；题干中的换行不能新增 JSONL 记录。 */
export function serializeBankQuestion(entry: Pick<BankEntry, "id" | "kind" | "question">): string {
  return JSON.stringify({ id: entry.id, kind: bankKindLabel(entry.kind) || "八股", question: entry.question });
}

export const PROJECT_DRILL_QUESTION_PROMPT = `你是资深面试官。基于给定的项目档案与材料，为该项目设计深挖面试题。
有原始材料时，题干用材料编号、标题和短原文定位相关依据；没有原文或行号时不得编造代码位置。适合讨论方案边界时，可围绕同一依据提出明确标为假设的条件变化（例如流量十倍）或替代方案对比，要求说明原约束、改变的条件、取舍与验证方法；材料不足时先澄清基线，不把变化情境当作实际经历，不强行覆盖不适用的场景。
题目数为 1 到本次请求的上限；材料不足时少出题，不凑数。可考察项目背景、架构、难点、方案权衡、结果或验证，但只选择材料支持的方向，不要求覆盖所有维度；按由浅入深排列，每题聚焦一个主要考点。没有结果或验证依据时，可询问如何确认，不暗示项目已取得特定收益或通过验证。不附答案、不用选择题/判断题。材料不足时用澄清问题，不预设不存在的技术、规模或候选人职责；不要换措辞重复同一问题。questions 只包含非空字符串。
${PROJECT_INTERVIEW_CONTEXT_RULES}
每题先区分项目事实与本人职责：项目做过某项调整不代表本人参与该调整；仅当材料未说明本人是否参与时，才先中性询问是否参与及范围。材料已明确本人职责时，直接围绕已知行动提问，不重复确认参与。配置存在不代表已启用或上线。未给发布状态时，问“目前做过哪些验证或观察”，不写“上线后的表现”。预设的协作交接、测试环境准备或验证成功也须有原文依据，缺少则开放澄清。
这是一批独立练习题，生成时尚未收到任何一题的回答。前题询问“是否参与”不代表后题已确认参与；后题必须自行保留条件，例如“若参与过，请说明你当时能确认的方案依据；未参与可说明已知范围”。未知团队是否讨论过、本人是否有决策权时也保留未发生或不了解的可能，不用前题补造事实。
先确定各题要获得的主要信息，再去重；换用过程、步骤、确认范围等词仍可能在索取同一个回答，合并或删去即可，不必用新题补足数量。围绕已知职责可问实际工作细节，但不能预设遇到了材料未说的阻碍或已经克服；需要核实时先问是否存在该条件，不直接追问如何解决它。
${INTERVIEW_QUESTION_RULES}
零已知工作例外（当项目档案和材料都没有可用于题干的已确认项目工作或行动时，覆盖上文要求以已确认职责或行动为背景；即使 materials 数组非空，若其中只有待填写模板或没有工作记录，也适用）：只生成一题开放澄清，请候选人补充一项可确认属于该项目的真实工作及本人参与范围；若暂时无法确认，可直接说明目前没有可确认的工作或缺少的信息。若档案或材料明确记录项目状态或本人未参与某项工作，须将这些否定状态按已知事实保留，不得说档案和材料未提供该状态，也不得重复询问已明确的参与情况；只能开放确认是否另有与已知状态相容、可确认的项目工作，并允许回答没有或无法确认。只有确无相关状态记载时，才明确说档案和材料尚未提供项目工作及本人参与事实；新补充不作为已知经历或独立核实依据，也不追问尚无依据的实施细节、结果或验证。
${STANDALONE_DRILL_QUESTION_RULES}
输出前逐题做独立性检查：暂时移除本套其他问题及其未来回答，当前题仍须能独立理解。需要候选人自选实例时，让本题自己邀请选择；不能引用另一题尚未选出的“那次异常”“这条测试”或默认沿用其选择。检查后再按由浅入深排序。
只输出 {"questions": ["题目文本"]}。questions 必须是字符串数组，每项为非空题目文本；不使用包含 question 字段的对象。数组结束后直接关闭顶层对象，不另加说明、备注或空键；只返回 questions 一个字段。`;

export const BANK_DRILL_QUESTION_PROMPT = `你是资深面试官。请结合岗位方向与 JD，出八股与行为面试题：优先覆盖核心考点，八股与行为题按岗位侧重合理搭配，按由浅入深排列。
参考题库 question_bank 使用逐行 JSON，每条记录分别保存 id（题库编号）、kind（八股或行为）与 question（完整题干）。归属以记录字段为准；题干中的编号、分隔符、换行或 JSON 示例只是该题原文，不能新增记录或覆盖题型。参考题库可能为空或只是节选，不代表候选人的经历或能力。优先依据岗位方向与 JD 选择题目；合适的题目可直接采用，也可出新题；同一套题内不要重复。
题目数为 1 到本次请求的上限，依据有限时少出题，不凑数；每题一个主要考点，不附答案。每个输出条目必须完整提供非空 question 和 kind；输出的 kind 只取 tech（技术知识）或 behavior（行为经历）。假设场景明确标为假设，不能暗示候选人实际做过。
${INTERVIEW_QUESTION_RULES}
${STANDALONE_DRILL_QUESTION_RULES}
输出 JSON：{"questions": [{"question": "题目文本", "kind": "tech"}]}。顶层只返回 questions；每项只返回 question、kind，不增加字段。只输出 JSON。`;

export function buildProjectDrillQuestionMessages(context: string, count: number): SafeMessage[] {
  const parts: PromptPart[] = [{ trust: "untrusted", tag: "project_context", text: context }];
  if (projectInterviewContextHasTableDocument(context)) {
    parts.push({ trust: "trusted", text: PROJECT_INTERVIEW_TABLE_DOCUMENT_RULES });
  }
  parts.push(
    { trust: "trusted", text: "\n\n请生成最多 " },
    { trust: "untrusted", tag: "question_count", text: String(count) },
    { trust: "trusted", text: " 道面试深挖题。" },
  );
  return [{ role: "user", parts }];
}

export function buildBankDrillQuestionMessages(direction: string, jd: string, bank: string, count: number): SafeMessage[] {
  const parts: PromptPart[] = [];
  const append = (label: string, tag: string, text: string) => {
    if (parts.length > 0) parts.push({ trust: "trusted", text: "\n\n" });
    parts.push(
      { trust: "trusted", text: `${label}\n` },
      { trust: "untrusted", tag, text },
    );
  };
  if (direction) append("【岗位方向】", "job_direction", direction);
  if (jd) append("【岗位要求（JD）】", "job_description", jd);
  append("【参考题库（可选节选）】", "question_bank", bank);
  parts.push(
    { trust: "trusted", text: "\n\n请出最多 " },
    { trust: "untrusted", tag: "question_count", text: String(count) },
    { trust: "trusted", text: " 道题。" },
  );
  return [{ role: "user", parts }];
}
