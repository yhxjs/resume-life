import { isGeneratedProjectSummary } from "@/lib/summary";
import { PROJECT_SUMMARY_OUTPUT_RULES, PROJECT_SUMMARY_SYSTEM_PROMPT } from "@/lib/project-summary-llm";
import { projectSummaryFieldBoundariesCases } from "./project-summary-field-boundaries-fixture";

const summaryObjectStart = PROJECT_SUMMARY_OUTPUT_RULES.indexOf("{");
if (summaryObjectStart < 0) throw new Error("project summary output contract has no JSON object");
const summaryObjectContract = PROJECT_SUMMARY_OUTPUT_RULES.slice(summaryObjectStart);

export const PROJECT_SUMMARY_EVIDENCE_LEDGER_OUTPUT_RULES = `先把本次材料整理成可核对的事实账本，再从账本生成项目总结。账本只记录材料原文支持的原子事实，不把职责、状态、计划或局部核对互相推成架构、问题或成果。每项事实必须标明材料编号、责任主体、适用项目/组件/样本/环境范围、材料明确的完成/验证状态，以及事实类型；未知项写“未知”。引用必须是该材料正文中的逐字连续片段，不补字、不改写。材料之间、局部样本与真实环境之间、已完成/进行中/未开始/未验证状态分别保留。
再依据事实账本和原始材料生成summary。每项summary陈述都须由账本中的相关事实支持；保留该事实所需的主体、范围和状态。architecture只采用已实现模块或数据流事实；challenges只采用实际问题及已有处理证据；brief与每条achievement分别保留本项采用事实的责任主体和适用限定，不依赖其他字段补充。账本和summary必须同时完整；材料缺少依据时按原八字段规则留空，不能为了填满账本或字段而推断。
只输出一个JSON对象，且只含evidence和summary两个键。evidence是事实对象数组，每项严格包含materialNumber、quote、subject、scope、status、type六个字段；本评测每例仅有编号1的一份材料。type只能为module-flow、responsibility、technical-solution、observed-problem、verification、project-status、documentation、other之一。summary必须是以下完整八字段项目总结，结构、字数、空值及achievements要求与原输出契约相同：
${summaryObjectContract}`;

const evidenceTypes = new Set([
  "module-flow", "responsibility", "technical-solution", "observed-problem",
  "verification", "project-status", "documentation", "other",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Candidate-only envelope; citations must be exact substrings of the fixed source. */
export function isProjectSummaryEvidenceLedger(value: unknown, source: string): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !("evidence" in value) || !("summary" in value)) return false;
  if (!isGeneratedProjectSummary(value.summary) || !Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 80) return false;
  return value.evidence.every(fact => {
    if (!isRecord(fact) || Object.keys(fact).length !== 6) return false;
    return fact.materialNumber === 1 &&
      typeof fact.quote === "string" && fact.quote.length > 0 && source.includes(fact.quote) &&
      typeof fact.subject === "string" && fact.subject.length > 0 &&
      typeof fact.scope === "string" && fact.scope.length > 0 &&
      typeof fact.status === "string" && fact.status.length > 0 &&
      typeof fact.type === "string" && evidenceTypes.has(fact.type);
  });
}

/** Replace only the output contract for this evaluation-only structural candidate. */
export function buildProjectSummaryEvidenceLedgerSystems(production = PROJECT_SUMMARY_SYSTEM_PROMPT): { baseline: string; candidate: string } {
  const baselineCount = production.split(PROJECT_SUMMARY_OUTPUT_RULES).length - 1;
  const candidateCount = production.split(PROJECT_SUMMARY_EVIDENCE_LEDGER_OUTPUT_RULES).length - 1;
  if (baselineCount + candidateCount !== 1) throw new Error("project-summary-evidence-ledger requires one known full-summary output contract");
  const baseline = candidateCount
    ? production.replace(PROJECT_SUMMARY_EVIDENCE_LEDGER_OUTPUT_RULES, PROJECT_SUMMARY_OUTPUT_RULES)
    : production;
  return { baseline, candidate: baseline.replace(PROJECT_SUMMARY_OUTPUT_RULES, PROJECT_SUMMARY_EVIDENCE_LEDGER_OUTPUT_RULES) };
}

export const projectSummaryEvidenceLedgerCases = projectSummaryFieldBoundariesCases;
