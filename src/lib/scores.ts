export type ScoreMap = {
  depth: number;
  structure: number;
  authenticity: number;
  completeness: number;
};

export const DIMENSIONS: { key: keyof ScoreMap; label: string; hint: string }[] = [
  { key: "depth", label: "技术深度", hint: "原理与取舍是否讲清" },
  { key: "structure", label: "结构表达", hint: "STAR 完整性与条理" },
  { key: "authenticity", label: "真实性", hint: "与项目档案/简历的一致性" },
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

/** 解析存储的 scores 列；格式损坏时按无分处理而不是让整个接口 500 */
export function safeScores(raw: string | null | undefined): ScoreMap | null {
  try {
    return normalizeScores(JSON.parse(raw || "null"));
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

/** 挖掘报告还须包含完整的项目复盘与简历要点。 */
export function normalizeGeneratedReport(raw: unknown, requireMining: boolean): InterviewReport | null {
  const report = normalizeReport(raw);
  if (!report) return null;
  if (requireMining) {
    const mining = report.mining_summary;
    if (!mining || [mining.project_name, mining.background, mining.actions, mining.tradeoffs, mining.results, mining.contribution]
      .some((text) => !text.trim()) || !mining.resume_bullets.length) return null;
    const source = (raw as { mining_summary: Record<string, unknown> }).mining_summary;
    if (!Array.isArray(source.resume_bullets) || source.resume_bullets.some((text) => typeof text !== "string" || !text.trim()) ||
        !Array.isArray(source.pending_confirmations) || source.pending_confirmations.some((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return true;
          const pending = item as Record<string, unknown>;
          return [pending.category, pending.item, pending.source_hint].some((text) => typeof text !== "string" || !text.trim());
        })) return null;
  }
  return report;
}

export type EvaluatorRecommendation = "Strong Hire" | "Hire" | "Lean No" | "No Hire";

export type EvaluatorEvidence = {
  turn_idx: number;
  topic: string;
  observation: string;
};

export type EvaluatorReport = {
  recommendation: EvaluatorRecommendation;
  level: string; // 对标阿里职级，如 P6 (资深工程师)、P7 (技术专家)
  level_justification: string; // 定级依据与距离上一级的边界判断
  summary_for_hr: string; // 呈报 HR 核心执行摘要
  hire_reasons: string[]; // 核心亮点/推荐理由
  concerns_and_risks: string[]; // 核心顾虑/潜在风险
  placement_suggestion: string; // 团队定位与入职培养/试用期考察建议
  evidence_quotes?: EvaluatorEvidence[]; // 关键题目实录佐证与心理洞察
};

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
    evidence_quotes: evidence_quotes.length > 0 ? evidence_quotes : undefined,
  };
}
