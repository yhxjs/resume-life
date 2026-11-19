import { LlmResponseError, type LlmResponseFailureReason, type LlmUsage } from "@/lib/llm-adapter";

export type EvaluationResponseError = {
  code: "provider" | "incomplete" | "protocol";
  reason: LlmResponseFailureReason | null;
  usage: LlmUsage | null;
};

const reasons = new Set<LlmResponseFailureReason>([
  "output_limit", "content_filter", "cancelled", "pending", "paused", "context_limit", "refusal", "tool_call",
]);

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 用量观察只保留有限数值；收到对象但没有已知值与未收到观察分别记录。 */
export function evaluationObservedUsage(usage: unknown): LlmUsage | null {
  return usage !== null && typeof usage === "object" && !Array.isArray(usage) ? {
    inputTokens: finiteOrNull((usage as LlmUsage).inputTokens),
    outputTokens: finiteOrNull((usage as LlmUsage).outputTokens),
    cachedTokens: finiteOrNull((usage as LlmUsage).cachedTokens),
  } : null;
}

/** 只保存调用层已分类的有限诊断，不复制提供方文本、错误链或任意扩展属性。 */
export function evaluationResponseError(error: unknown, stage: "input" | "call" | "validation"): EvaluationResponseError | null {
  if (stage !== "call" || !(error instanceof LlmResponseError)) return null;
  const { code, reason, usage } = error;
  if (code !== "provider" && code !== "incomplete" && code !== "protocol") return null;
  return {
    code,
    reason: reasons.has(reason as LlmResponseFailureReason) ? reason : null,
    usage: evaluationObservedUsage(usage),
  };
}
