import { buildPriorSeriesContext } from "@/lib/interview-series-context";
import { seriesRoundOf } from "@/lib/series";

/** 仅生成合成的已保存前轮记录；实际消息序列化与去重使用生产函数。 */
export function seriesContextFixture(roundNo: number, questions: readonly string[], feedback: {
  strengths: string; weaknesses: string; suggestions: string;
} | null) {
  const round = seriesRoundOf(roundNo);
  if (!round) throw new Error("Unknown prior series round");
  return buildPriorSeriesContext([{
    round_no: roundNo, style: round.style,
    report: feedback ? JSON.stringify({ depth: 5, structure: 5, authenticity: 5, completeness: 5, jd_match: 5, ...feedback }) : "{invalid-report",
  }], questions.map((question, index) => ({ round_no: roundNo, idx: index + 1, kind: "question", question })));
}
