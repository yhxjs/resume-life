import type { ProjectMaterialRecordSource } from "../src/lib/project-material-record";
import { PROJECT_SUMMARY_OUTPUT_RULES, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../src/lib/project-summary-llm";
import { resolveUntrustedSourceQuote } from "../src/lib/prompt-safety";
import { hasQuestionContent } from "../src/lib/question-normalization";
import { isGeneratedProjectSummary, normalizeSummary, PROJECT_SUMMARY_OUTPUT_LIMITS, type ProjectSummary } from "../src/lib/summary";

export type ProjectChallengeEvidenceReference = { materialNumber: number; quote: string };
export type ProjectChallengeEvidenceIssue = {
  problem: ProjectChallengeEvidenceReference;
  handling: ProjectChallengeEvidenceReference[];
  outcome: ProjectChallengeEvidenceReference[];
};
export type ProjectChallengeEvidenceSummary = Omit<ProjectSummary, "challenges"> & {
  challenges: ProjectChallengeEvidenceIssue[];
};

const dimensionLimit = PROJECT_SUMMARY_OUTPUT_LIMITS.dimension;
const dimensionBefore = `五维字段只填该维度已有的具体证据，用于深度面试准备；材料充分时展开实现机制、方案取舍与验证依据，不照搬简历短句。无对应证据留空，每项硬上限 ${dimensionLimit} 字。`;
const dimensionAfter = `五维只采用各自已有的具体证据。overview、architecture、highlights、responsibilities 四个文本维度可以是一句，无对应证据用空字符串，每项硬上限 ${dimensionLimit} 字；challenges 用下述问题证据数组，无实际问题用 []，全部引文经分号连接后的文本硬上限 ${dimensionLimit} 字。`;
const challengeBefore = "challenges 放实际问题及处理依据。";
const challengeAfter = "challenges 用 problem 引用实际问题或阻碍，handling 与 outcome 引用有关处理、结果和状态；不另写自由总结。";

const evidenceRules = `问题证据数组规则：
- challenges 的每项恰有 problem、handling、outcome 三个键。problem 为引用对象，handling、outcome 为引用对象数组；引用对象恰有 materialNumber 和 quote 两个键。例如结构为 {"problem":{"materialNumber":1,"quote":"实际问题的连续原文"},"handling":[],"outcome":[]}，数字与文字只是格式示意，不是本项目事实。
- materialNumber 使用本次原始材料从 1 开始的输入编号；quote 必须逐字连续存在于该编号材料的 content 中，不能改写、拼接、跨材料引用或引用标题、项目名、档案及示例。quote 非空且有实质内容，保留其原始空白、换行、标点与限定；引用不适用其余写作规则中的压缩、删除类名或函数名等改写要求。
- problem 必须有实际问题、异常现象或实际阻碍的原文依据；纯提交、未测试、未发布及实现状态未知不能独立成为 problem。没有实际问题时 challenges 返回 []，不以进度填充问题；不能据此推断项目没有任何问题或已经验证通过。
- 有实际问题但尚无处理方案时仍保留 problem，handling 可以为空；outcome 保留已有的结果、未解决、未定位或未验证等适用状态，未知不补造。已有处理与有限验证也须保留原文范围，不能因问题已处理而删掉问题，不能把一次局部验证写成整体成功。相关事实可在一段连续引文中保留，不必为分槽重复引用同一段。
- 按问题顺序输出，每项按 problem、handling、outcome 的顺序呈现引用。同一项中恢复为原文后完全相同的引用不得重复；不同问题可以共享真实处理或状态引用，但 problem 的原文不得完全重复。调用方仅把这些原文依次用中文分号“；”连接为旧 challenges 字符串，不删字、不去重、不截断；跨问题共享的引文也原样保留并计入 ${dimensionLimit} 字上限。其他七字段保持原协议，文本总量按最终八字段计算。
- 引文存在只证明来源匹配，不证明它属于实际问题、处理或结果；这些分类仍须符合以上事实要求。`;

function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2 || source.includes(after)) {
    throw new Error("project-challenge-evidence requires one unchanged production output block and dimension contract");
  }
  return source.replace(before, after);
}

/** Evaluation only: change the generation contract, never the production prompt or stored summary shape. */
export function buildProjectChallengeEvidenceSystem(production = PROJECT_SUMMARY_SYSTEM_PROMPT): string {
  if ((production.match(/"challenges"\s*:/g) ?? []).length !== 1 || production.includes("challenges=[]")) {
    throw new Error("project-challenge-evidence requires one unchanged production output block and dimension contract");
  }
  let outputRules = replaceOnce(PROJECT_SUMMARY_OUTPUT_RULES,
    "字段值不带标题前缀：", "字段值不带标题前缀（quote 原文引用除外）：");
  outputRules = replaceOnce(outputRules,
    '  "challenges": "已知问题、应对方式与有证据的结果",', '  "challenges": [],');
  outputRules = replaceOnce(outputRules, "七个文本字段均为字符串", "六个文本字段均为字符串");
  outputRules += `\n${evidenceRules}`;
  let candidate = replaceOnce(production, PROJECT_SUMMARY_OUTPUT_RULES, outputRules);
  candidate = replaceOnce(candidate, dimensionBefore, dimensionAfter);
  candidate = replaceOnce(candidate, challengeBefore, challengeAfter);
  return replaceOnce(candidate, 'challenges=""', "challenges=[]");
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keysEqual = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Source matching is mechanical; it does not decide whether a quoted status is a real problem. */
export function consumeProjectChallengeEvidence(
  raw: unknown,
  materials: readonly ProjectMaterialRecordSource[],
): ProjectSummary | null {
  // This prototype addresses plain content records only, not archive-only or DOCX/scanner inputs.
  if (!Array.isArray(materials) || materials.length === 0 ||
      !materials.every(material => record(material) && typeof material.title === "string" && typeof material.content === "string" && material.tableProvenance == null) ||
      !materials.some(material => material.content.trim()) || !record(raw) || !Array.isArray(raw.challenges)) return null;
  const readQuote = (value: unknown): string | null => {
    if (!record(value) || !keysEqual(value, ["materialNumber", "quote"]) ||
        typeof value.materialNumber !== "number" || !Number.isSafeInteger(value.materialNumber) || value.materialNumber < 1 ||
        typeof value.quote !== "string" || !value.quote.trim()) return null;
    const material = materials[value.materialNumber - 1];
    if (!material) return null;
    const quote = resolveUntrustedSourceQuote(value.quote, material.content);
    return quote !== null && hasQuestionContent(quote) ? quote : null;
  };
  const problems = new Set<string>();
  const fragments: string[] = [];
  let length = 0;
  for (const issue of raw.challenges) {
    if (!record(issue) || !keysEqual(issue, ["problem", "handling", "outcome"]) ||
        !Array.isArray(issue.handling) || !Array.isArray(issue.outcome)) return null;
    const problem = readQuote(issue.problem);
    if (problem === null || problems.has(problem)) return null;
    problems.add(problem);
    const issueQuotes = new Set<string>();
    for (const quote of [problem, ...issue.handling.map(readQuote), ...issue.outcome.map(readQuote)]) {
      if (quote === null || issueQuotes.has(quote)) return null;
      issueQuotes.add(quote);
      length += quote.length + (fragments.length === 0 ? 0 : 1);
      if (length > dimensionLimit) return null;
      fragments.push(quote);
    }
  }
  const summary = { ...raw, challenges: fragments.join("；") };
  return isGeneratedProjectSummary(summary) ? normalizeSummary(summary) : null;
}
