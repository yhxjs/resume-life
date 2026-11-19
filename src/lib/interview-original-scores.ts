import { readStoredScores, type ScoreMap } from "@/lib/scores";

export const ORIGINAL_SCORES_UNAVAILABLE = "原答评分缺失或损坏，原始记录已保留。请刷新核对或从有效备份恢复；重答不会补写原评分。";

/** 读取原始评分；合法小数不取整，空列／旧 null 与损坏数据分开处理，投影不写回。 */
export function readInterviewOriginalScores(raw: string): { scores: ScoreMap | null } | null {
  let value: unknown;
  try { value = JSON.parse(raw || "null"); }
  catch { return null; }
  if (value === null) return { scores: null };
  const scores = readStoredScores(value);
  return scores ? { scores } : null;
}
