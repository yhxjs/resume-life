import { DIMENSIONS, type ScoreMap } from "@/lib/scores";

export type TurnRetry = {
  id: string;
  answer: string;
  scores: ScoreMap | null;
  comment: string;
  reference?: string;
  created_at: string;
};

export const RETRY_HISTORY_UNAVAILABLE = "重答历史暂无法读取，原始记录已保留。请刷新核对，或从有效备份恢复后再重答。";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isInterviewRetry(value: unknown): value is TurnRetry {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() ||
      typeof value.answer !== "string" || typeof value.comment !== "string" ||
      typeof value.created_at !== "string" ||
      (value.reference !== undefined && typeof value.reference !== "string")) return false;
  const scores = value.scores;
  return scores === null || (isRecord(scores) && DIMENSIONS.every(({ key }) =>
    typeof scores[key] === "number" && Number.isFinite(scores[key]) && scores[key] >= 0 && scores[key] <= 10));
}

/** 只为缺失的历史字段提供显示默认值；错误类型不转换，合法正文与小数分不裁剪。 */
export function normalizeInterviewRetryHistory(value: unknown): TurnRetry[] | null {
  if (!Array.isArray(value)) return null;
  const retries: TurnRetry[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return null;
    const retry = {
      id: item.id,
      answer: item.answer === undefined ? "" : item.answer,
      scores: item.scores === undefined ? null : item.scores,
      comment: item.comment === undefined ? "" : item.comment,
      created_at: item.created_at === undefined ? "" : item.created_at,
      ...(item.reference !== undefined ? { reference: item.reference } : {}),
    };
    if (!isInterviewRetry(retry) || ids.has(retry.id)) return null;
    ids.add(retry.id);
    retries.push(retry);
  }
  return retries;
}

/** 展示投影不可写回；追加时保留 stored 中既有字段，包括历史扩展字段。 */
export function readInterviewRetryHistory(raw: string): { stored: unknown[]; retries: TurnRetry[] } | null {
  let stored: unknown;
  try { stored = JSON.parse(raw || "[]"); }
  catch { return null; }
  if (!Array.isArray(stored)) return null;
  const retries = normalizeInterviewRetryHistory(stored);
  return retries === null ? null : { stored, retries };
}
