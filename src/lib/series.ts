/** 进阶面试固定三轮：一面技术面 → 二面主管面 → 三面 HR 面，轮次与人设一一对应 */
export const SERIES_ROUNDS = 3;

export type SeriesRoundDef = {
  no: number;
  label: string;
  style: "deep" | "manager" | "hr";
  desc: string;
};

export const SERIES_ROUND_DEFS: SeriesRoundDef[] = [
  { no: 1, label: "一面 · 技术面", style: "deep", desc: "项目与基础的技术深挖" },
  { no: 2, label: "二面 · 主管面", style: "manager", desc: "方案权衡、取舍与决策" },
  { no: 3, label: "三面 · HR 面", style: "hr", desc: "动机、协作与行为" },
];

export function seriesRoundOf(no: number): SeriesRoundDef | undefined {
  return SERIES_ROUND_DEFS.find((d) => d.no === no);
}

/** 跨轮总评：三轮报告全部齐备后由 AI 合成，overall 为三轮总分的平均（代码计算） */
export type SeriesReport = {
  overall: number;
  verdict: string;
  strengths: string;
  weaknesses: string;
  suggestions: string;
};

export function normalizeSeriesReport(raw: unknown): SeriesReport | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const overall = Number(o.overall);
  const verdict = typeof o.verdict === "string" ? o.verdict.trim() : "";
  if (!Number.isFinite(overall) || overall < 0 || overall > 10 || !verdict) return null;
  if ([o.strengths, o.weaknesses, o.suggestions].some((text) => typeof text !== "string" || !text.trim())) return null;
  return {
    overall: Math.round(overall * 10) / 10,
    verdict,
    strengths: typeof o.strengths === "string" ? o.strengths : "",
    weaknesses: typeof o.weaknesses === "string" ? o.weaknesses : "",
    suggestions: typeof o.suggestions === "string" ? o.suggestions : "",
  };
}
