import { hasQuestionContent } from "./question-normalization";

export type ScoreMap = {
  depth: number;
  structure: number;
  authenticity: number;
  completeness: number;
};

export const DIMENSIONS: { key: keyof ScoreMap; label: string; hint: string }[] = [
  { key: "depth", label: "技术深度", hint: "按题型评价原理、依据与取舍" },
  { key: "structure", label: "结构表达", hint: "表达清晰有条理，STAR 仅为可选组织方式" },
  { key: "authenticity", label: "真实性", hint: "具体性、自洽性及与所提供材料的一致性，不代表事实核验" },
  { key: "completeness", label: "完整度", hint: "是否覆盖问题要点" },
];

function scoreNumber(raw: unknown): number {
  if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) return NaN;
  return Number(raw);
}

export function normalizeScores(raw: unknown): ScoreMap | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const result = {} as ScoreMap;
  for (const d of DIMENSIONS) {
    const v = scoreNumber(o[d.key]);
    if (!Number.isFinite(v) || v < 0 || v > 10) return null;
    result[d.key] = Math.round(v);
  }
  return result;
}

/** 已存逐题评分按原值读取；拒绝类型转换，合法小数只在汇总时舍入。 */
export function readStoredScores(raw: unknown): ScoreMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const scores = {} as ScoreMap;
  for (const { key } of DIMENSIONS) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10) return null;
    scores[key] = value;
  }
  return scores;
}

/** 新生成的逐题评分只接受 JSON 整数；不放宽为历史存储的小数规则。 */
export function validateGeneratedScores(raw: unknown): ScoreMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const scores = {} as ScoreMap;
  for (const { key } of DIMENSIONS) {
    const value = source[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10) return null;
    scores[key] = value;
  }
  return scores;
}

/** 合法数字评分保留小数；旧数字字符串沿用归一化兼容，损坏数据按无分处理。 */
export function safeScores(raw: string | null | undefined): ScoreMap | null {
  try {
    const value: unknown = JSON.parse(raw || "null");
    return readStoredScores(value) ?? normalizeScores(value);
  } catch {
    return null;
  }
}

export function averageScores(list: ScoreMap[]): ScoreMap | null {
  if (list.length === 0) return null;
  const result = {} as ScoreMap;
  for (const d of DIMENSIONS) {
    const sum = list.reduce((acc, s) => acc + s[d.key], 0);
    result[d.key] = Math.round((sum / list.length) * 10) / 10;
  }
  return result;
}

/** 四维均分的综合分，保留 1 位小数。 */
export function overallOf(avg: ScoreMap): number {
  const sum = DIMENSIONS.reduce((acc, d) => acc + avg[d.key], 0);
  return Math.round((sum / DIMENSIONS.length) * 10) / 10;
}

export type MiningConfirmationItem = {
  category: string;
  item: string;
  source_hint: string;
};

export type MiningSummary = {
  project_name: string;
  background: string;
  actions: string;
  tradeoffs: string;
  results: string;
  contribution: string;
  pending_confirmations: MiningConfirmationItem[];
  resume_bullets: string[];
};

export type InterviewReport = {
  depth: number;
  structure: number;
  authenticity: number;
  completeness: number;
  jd_match: number;
  overall: number;
  strengths: string;
  weaknesses: string;
  suggestions: string;
  mining_summary?: MiningSummary;
};

/** 新生成报告的篇幅上限；历史报告读取继续保持兼容。 */
export const INTERVIEW_REPORT_OUTPUT_LIMITS = {
  summaryText: 1200,
  miningText: 2000,
  resumeBullets: 5,
  resumeBullet: 600,
  pendingConfirmations: 20,
  pendingCategory: 100,
  pendingItem: 600,
  pendingSourceHint: 300,
} as const;

export type InterviewDimensionKey = "depth" | "structure" | "authenticity" | "completeness" | "jd_match";

export const INTERVIEW_DIMENSIONS: { key: InterviewDimensionKey; label: string }[] = [
  { key: "depth", label: "技术深度" },
  { key: "structure", label: "结构表达" },
  { key: "authenticity", label: "真实性" },
  { key: "completeness", label: "完整度" },
  { key: "jd_match", label: "岗位匹配" },
];

/** 报告中的低分维度（<7 分，与 scoreTextCls 的低分线一致）；都不低时取最低两维作为追练重点 */
export function weakDimensions(report: InterviewReport): InterviewDimensionKey[] {
  const weak = INTERVIEW_DIMENSIONS.filter((d) => report[d.key] < 7).map((d) => d.key);
  if (weak.length > 0) return weak;
  return [...INTERVIEW_DIMENSIONS]
    .sort((a, b) => report[a.key] - report[b.key])
    .slice(0, 2)
    .map((d) => d.key);
}

export function normalizeReport(raw: unknown): InterviewReport | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if ([o.strengths, o.weaknesses, o.suggestions].some((text) => typeof text !== "string" || !text.trim())) return null;
  const report: InterviewReport = {
    depth: scoreNumber(o.depth),
    structure: scoreNumber(o.structure),
    authenticity: scoreNumber(o.authenticity),
    completeness: scoreNumber(o.completeness),
    jd_match: scoreNumber(o.jd_match),
    overall: 0,
    strengths: o.strengths as string,
    weaknesses: o.weaknesses as string,
    suggestions: o.suggestions as string,
  };
  for (const d of INTERVIEW_DIMENSIONS) {
    const value = report[d.key] as number;
    if (!Number.isFinite(value) || value < 0 || value > 10) return null;
  }
  const avg =
    (report.depth + report.structure + report.authenticity + report.completeness + report.jd_match) /
    5;
  report.overall = Math.round(avg * 10) / 10;

  if (o.mining_summary && typeof o.mining_summary === "object" && !Array.isArray(o.mining_summary)) {
    const ms = o.mining_summary as Record<string, unknown>;
    const pendingConfirmations: MiningConfirmationItem[] = [];
    if (Array.isArray(ms.pending_confirmations)) {
      for (const item of ms.pending_confirmations) {
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          pendingConfirmations.push({
            category: typeof rec.category === "string" ? rec.category.trim() : "待确认",
            item: typeof rec.item === "string" ? rec.item.trim() : "",
            source_hint: typeof rec.source_hint === "string" ? rec.source_hint.trim() : "",
          });
        }
      }
    }
    const resumeBullets = Array.isArray(ms.resume_bullets)
      ? ms.resume_bullets.map((b) => (typeof b === "string" ? b.trim() : "")).filter(Boolean)
      : [];

    report.mining_summary = {
      project_name: typeof ms.project_name === "string" ? ms.project_name.trim() : "",
      background: typeof ms.background === "string" ? ms.background.trim() : "",
      actions: typeof ms.actions === "string" ? ms.actions.trim() : "",
      tradeoffs: typeof ms.tradeoffs === "string" ? ms.tradeoffs.trim() : "",
      results: typeof ms.results === "string" ? ms.results.trim() : "",
      contribution: typeof ms.contribution === "string" ? ms.contribution.trim() : "",
      pending_confirmations: pendingConfirmations.filter((p) => p.item.length > 0),
      resume_bullets: resumeBullets,
    };
  }

  return report;
}

/** 完整报告检查；历史分数兼容读取，挖掘成果未知可留空，但不能只有空壳。 */
export function normalizeCompleteReport(raw: unknown, requireMining: boolean): InterviewReport | null {
  const report = normalizeReport(raw);
  if (!report) return null;
  if (requireMining) {
    const mining = report.mining_summary;
    if (!mining) return null;
    const source = (raw as { mining_summary: Record<string, unknown> }).mining_summary;
    const textKeys = ["project_name", "background", "actions", "tradeoffs", "results", "contribution"] as const;
    // 在兼容清洗之前的原始字段上校验，避免把缺失或错误类型当作明确未知。
    if (textKeys.some((key) => typeof source[key] !== "string")) return null;
    if (!Array.isArray(source.resume_bullets) || source.resume_bullets.some((text) => typeof text !== "string" || !text.trim()) ||
        !Array.isArray(source.pending_confirmations) || source.pending_confirmations.some((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return true;
          const pending = item as Record<string, unknown>;
          return [pending.category, pending.item, pending.source_hint].some((text) => typeof text !== "string" || !text.trim());
        })) return null;
    if (!textKeys.some((key) => mining[key].length > 0) &&
        !mining.resume_bullets.length && !mining.pending_confirmations.length) return null;
  }
  return report;
}

/** 新报告的模型岗位评分须为整数；服务端汇总的其余四维保留小数。 */
export function validateGeneratedReport(raw: unknown, requireMining: boolean): InterviewReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  if (!hasExactKeys(source, requireMining
    ? ["depth", "structure", "authenticity", "completeness", "jd_match", "strengths", "weaknesses", "suggestions", "mining_summary"]
    : ["depth", "structure", "authenticity", "completeness", "jd_match", "strengths", "weaknesses", "suggestions"])) return null;
  const jdMatch = source.jd_match;
  if (typeof jdMatch !== "number" || !Number.isInteger(jdMatch) || jdMatch < 0 || jdMatch > 10) return null;
  if (!requireMining && source.mining_summary !== undefined) return null;
  const summaryKeys = ["strengths", "weaknesses", "suggestions"] as const;
  if (summaryKeys.some((key) => typeof source[key] !== "string" || !(source[key] as string).trim() || !hasQuestionContent(source[key] as string) ||
      (source[key] as string).length > INTERVIEW_REPORT_OUTPUT_LIMITS.summaryText)) return null;

  if (requireMining) {
    if (!source.mining_summary || typeof source.mining_summary !== "object" || Array.isArray(source.mining_summary)) return null;
    const mining = source.mining_summary as Record<string, unknown>;
    if (!hasExactKeys(mining, ["project_name", "background", "actions", "tradeoffs", "results", "contribution", "pending_confirmations", "resume_bullets"])) return null;
    const textKeys = ["project_name", "background", "actions", "tradeoffs", "results", "contribution"] as const;
    if (textKeys.some((key) => typeof mining[key] !== "string" ||
        (mining[key] as string).length > INTERVIEW_REPORT_OUTPUT_LIMITS.miningText ||
        ((mining[key] as string).length > 0 && !hasQuestionContent(mining[key] as string)))) return null;
    if (!Array.isArray(mining.resume_bullets) || mining.resume_bullets.length > INTERVIEW_REPORT_OUTPUT_LIMITS.resumeBullets ||
        mining.resume_bullets.some((item) => typeof item !== "string" || !item.trim() || !hasQuestionContent(item) || item.length > INTERVIEW_REPORT_OUTPUT_LIMITS.resumeBullet) ||
        !Array.isArray(mining.pending_confirmations) || mining.pending_confirmations.length > INTERVIEW_REPORT_OUTPUT_LIMITS.pendingConfirmations ||
        mining.pending_confirmations.some((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return true;
          const pending = item as Record<string, unknown>;
          if (!hasExactKeys(pending, ["category", "item", "source_hint"])) return true;
          return typeof pending.category !== "string" || !pending.category.trim() || !hasQuestionContent(pending.category) || pending.category.length > INTERVIEW_REPORT_OUTPUT_LIMITS.pendingCategory ||
            typeof pending.item !== "string" || !pending.item.trim() || !hasQuestionContent(pending.item) || pending.item.length > INTERVIEW_REPORT_OUTPUT_LIMITS.pendingItem ||
            typeof pending.source_hint !== "string" || !pending.source_hint.trim() || !hasQuestionContent(pending.source_hint) || pending.source_hint.length > INTERVIEW_REPORT_OUTPUT_LIMITS.pendingSourceHint;
        })) return null;
  }
  return normalizeCompleteReport(raw, requireMining);
}

export type EvaluatorRecommendation = "Strong Hire" | "Hire" | "Lean No" | "No Hire";

export type EvaluatorEvidence = {
  turn_idx: number;
  topic: string;
  observation: string;
};

export type EvaluatorReport = {
  recommendation: EvaluatorRecommendation;
  level: string; // 模拟职级参考，非公司官方定级；证据不足时为“暂无法判断”
  level_justification: string; // 职级参考的依据与证据局限
  summary_for_hr: string; // 历史字段名；实际为模拟评估摘要
  hire_reasons: string[]; // 核心亮点/推荐理由
  concerns_and_risks: string[]; // 核心顾虑/潜在风险
  placement_suggestion: string; // 团队定位与入职培养/试用期考察建议
  evidence_quotes: EvaluatorEvidence[]; // 历史字段名；实际是回答依据摘要，旧记录缺少时归一化为空数组
};

/** 新生成评估的硬上限；历史报告读取不应用这些限制。 */
export const EVALUATOR_REPORT_OUTPUT_LIMITS = {
  level: 100,
  levelJustification: 1200,
  summaryForHr: 1200,
  placementSuggestion: 1200,
  listItems: 5,
  hireReason: 400,
  concern: 500,
  evidenceItems: 3,
  topic: 160,
  observation: 600,
} as const;

export function normalizeEvaluatorReport(raw: unknown): EvaluatorReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const rec = typeof o.recommendation === "string" ? o.recommendation.trim() : "";
  const validRecs: EvaluatorRecommendation[] = ["Strong Hire", "Hire", "Lean No", "No Hire"];
  if (!validRecs.includes(rec as EvaluatorRecommendation)) return null;
  if (typeof o.level !== "string" || !o.level.trim()) return null;
  if (typeof o.level_justification !== "string" || !o.level_justification.trim() ||
      typeof o.summary_for_hr !== "string" || !o.summary_for_hr.trim() ||
      typeof o.placement_suggestion !== "string" || !o.placement_suggestion.trim()) return null;
  if (!Array.isArray(o.hire_reasons) || o.hire_reasons.some((r) => typeof r !== "string") ||
      !Array.isArray(o.concerns_and_risks) || o.concerns_and_risks.some((r) => typeof r !== "string")) return null;

  const hire_reasons = o.hire_reasons.map((r: string) => r.trim()).filter(Boolean);
  const concerns_and_risks = o.concerns_and_risks.map((c: string) => c.trim()).filter(Boolean);

  const evidence_quotes: EvaluatorEvidence[] = [];
  if (Array.isArray(o.evidence_quotes)) {
    for (const eq of o.evidence_quotes) {
      if (eq && typeof eq === "object") {
        const item = eq as Record<string, unknown>;
        evidence_quotes.push({
          turn_idx: Number(item.turn_idx) || 1,
          topic: String(item.topic || ""),
          observation: String(item.observation || ""),
        });
      }
    }
  }

  return {
    recommendation: rec as EvaluatorRecommendation,
    level: o.level.trim(),
    level_justification: o.level_justification.trim(),
    summary_for_hr: o.summary_for_hr.trim(),
    hire_reasons,
    concerns_and_risks,
    placement_suggestion: o.placement_suggestion.trim(),
    evidence_quotes,
  };
}

/** 新报告的证据只能引用本次提供的已作答题号，不能通过兼容清洗补造引用。 */
export function validateGeneratedEvaluatorReport(raw: unknown, answeredTurnIndexes: readonly number[]): EvaluatorReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  if (!exactKeys(source, ["recommendation", "level", "level_justification", "summary_for_hr", "hire_reasons", "concerns_and_risks", "placement_suggestion", "evidence_quotes"])) return null;
  const boundedText = (value: unknown, maxChars: number) =>
    typeof value === "string" && value.trim().length > 0 && hasQuestionContent(value) && value.length <= maxChars;
  if (!boundedText(source.level, EVALUATOR_REPORT_OUTPUT_LIMITS.level) ||
      !boundedText(source.level_justification, EVALUATOR_REPORT_OUTPUT_LIMITS.levelJustification) ||
      !boundedText(source.summary_for_hr, EVALUATOR_REPORT_OUTPUT_LIMITS.summaryForHr) ||
      !boundedText(source.placement_suggestion, EVALUATOR_REPORT_OUTPUT_LIMITS.placementSuggestion)) return null;

  const boundedList = (value: unknown, maxItemChars: number): value is string[] =>
    Array.isArray(value) && value.length <= EVALUATOR_REPORT_OUTPUT_LIMITS.listItems &&
    value.every((item) => boundedText(item, maxItemChars));
  if (!boundedList(source.hire_reasons, EVALUATOR_REPORT_OUTPUT_LIMITS.hireReason) ||
      !boundedList(source.concerns_and_risks, EVALUATOR_REPORT_OUTPUT_LIMITS.concern)) return null;
  const recommendation = typeof source.recommendation === "string" ? source.recommendation.trim() : "";
  if ((recommendation === "Strong Hire" || recommendation === "Hire") && source.hire_reasons.length === 0) return null;
  if (recommendation === "No Hire" && source.concerns_and_risks.length === 0) return null;

  const evidence = source.evidence_quotes;
  if (!Array.isArray(evidence) || evidence.length > EVALUATOR_REPORT_OUTPUT_LIMITS.evidenceItems) return null;
  const allowed = new Set(answeredTurnIndexes);
  const seen = new Set<number>();
  for (const item of evidence) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (!exactKeys(entry, ["turn_idx", "topic", "observation"])) return null;
    if (typeof entry.turn_idx !== "number" || !Number.isSafeInteger(entry.turn_idx) || entry.turn_idx < 1 ||
        !allowed.has(entry.turn_idx) || seen.has(entry.turn_idx) ||
        !boundedText(entry.topic, EVALUATOR_REPORT_OUTPUT_LIMITS.topic) ||
        !boundedText(entry.observation, EVALUATOR_REPORT_OUTPUT_LIMITS.observation)) return null;
    seen.add(entry.turn_idx);
  }
  return normalizeEvaluatorReport(raw);
}
