import { interviewStyleOf } from "@/lib/interview";
import { normalizeReport } from "@/lib/scores";
import type { PromptPart } from "@/lib/safe-llm";
import { questionComparisonKey } from "@/lib/question-normalization";

export type PriorSeriesRound = { round_no: number; style: string; report: string };
export type PriorSeriesQuestion = { round_no: number; idx: number; kind: string; question: string };

/** 生产与评测从同一份记录生成前轮消息和去重集合，避免检查模型没有见过的题。 */
export function buildPriorSeriesContext(rounds: readonly PriorSeriesRound[], questions: readonly PriorSeriesQuestion[]): {
  parts: PromptPart[];
  questions: Set<string>;
} {
  const feedback = rounds.flatMap((row) => {
    try {
      const report = normalizeReport(JSON.parse(row.report));
      return report ? [{
        round_no: row.round_no,
        style: interviewStyleOf(row.style).label,
        feedback: { strengths: report.strengths, weaknesses: report.weaknesses, suggestions: report.suggestions },
      }] : [];
    } catch { return []; }
  });
  const parts: PromptPart[] = [
    ...(feedback.length > 0 ? [
      { trust: "trusted", text: "\n\n【前轮模型反馈摘要（未附原答，仅供设计核实问题）】\n" } as const,
      { trust: "untrusted", tag: "prior_interview_feedback", text: JSON.stringify(feedback) } as const,
    ] : []),
    { trust: "trusted", text: "\n\n【前轮题目记录（仅本进阶面试，不含原答）】\n" },
    { trust: "untrusted", tag: "prior_interview_questions", text: JSON.stringify(questions) },
  ];
  return { parts, questions: new Set(questions.map((item) => questionComparisonKey(item.question))) };
}
