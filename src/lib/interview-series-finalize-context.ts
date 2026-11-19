import { interviewStyleOf } from "@/lib/interview";
import { normalizeReport, type EvaluatorEvidence } from "@/lib/scores";
import type { SeriesFinalizeRoundInput } from "@/lib/interview-series-finalize-llm";

export type SeriesFinalizeRoundSource = {
  round_no: number;
  style: string;
  report: string;
  evaluator_report: string;
};

/** 只取严格有效的观察，不引入旧录用标签，也不让历史兼容清洗补造题号。 */
function readRoundEvidence(raw: string, answeredTurnIndexes: ReadonlySet<number>): EvaluatorEvidence[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const evidence = (parsed as Record<string, unknown>).evidence_quotes;
    if (!Array.isArray(evidence) || evidence.length === 0) return null;
    const result: EvaluatorEvidence[] = [];
    const seen = new Set<number>();
    for (const item of evidence) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.turn_idx !== "number" || !Number.isSafeInteger(entry.turn_idx) || entry.turn_idx <= 0 ||
          !answeredTurnIndexes.has(entry.turn_idx) || seen.has(entry.turn_idx) ||
          typeof entry.topic !== "string" || !entry.topic.trim() || typeof entry.observation !== "string" || !entry.observation.trim()) return null;
      seen.add(entry.turn_idx);
      result.push({ turn_idx: entry.turn_idx, topic: entry.topic, observation: entry.observation });
    }
    return result;
  } catch { return null; }
}

/** 生产与评测共用存档整理：重算分数，只携带经本轮已答题号核对的观察。 */
export function readSeriesFinalizeRound(source: SeriesFinalizeRoundSource, answeredTurnIndexes: ReadonlySet<number>): SeriesFinalizeRoundInput | null {
  let report;
  try { report = normalizeReport(JSON.parse(source.report)); }
  catch { return null; }
  if (!report) return null;
  return {
    round_no: source.round_no,
    style: interviewStyleOf(source.style).label,
    scores: { overall: report.overall, depth: report.depth, structure: report.structure,
      authenticity: report.authenticity, completeness: report.completeness, jd_match: report.jd_match },
    summary: { strengths: report.strengths, weaknesses: report.weaknesses, suggestions: report.suggestions },
    evidence: readRoundEvidence(source.evaluator_report, answeredTurnIndexes),
  };
}
