import { DIMENSIONS } from "@/lib/scores";
import { isInterviewRetry, normalizeInterviewRetryHistory } from "@/lib/interview-retry-history";
export type { TurnRetry } from "@/lib/interview-retry-history";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 成功回包须属于本次提交；历史末条可能来自另一并发请求，不能作为缺失回执的替代。 */
export function parseInterviewRetryResponse(value: unknown, request: { id: string; answer: string }) {
  const invalid = () => new Error("服务器返回的重答结果不完整，请使用原提交重试");
  if (!isRecord(value) || !isInterviewRetry(value.retry)) throw invalid();
  const retry = value.retry;
  const retries = normalizeInterviewRetryHistory(value.retries);
  if (!retries?.length || retry.id !== `retry_${request.id.toLowerCase()}` || retry.answer !== request.answer) throw invalid();
  const selected = retries.findIndex(item => item.id === retry.id);
  const saved = retries[selected];
  if (!saved || saved.answer !== retry.answer || saved.comment !== retry.comment ||
      saved.reference !== retry.reference || saved.created_at !== retry.created_at ||
      (saved.scores === null) !== (retry.scores === null) ||
      DIMENSIONS.some(({ key }) => saved.scores?.[key] !== retry.scores?.[key])) throw invalid();
  return { retries, selected };
}
