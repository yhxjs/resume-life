export const DEFAULT_EVALUATION_TIMEOUT_MS = 60_000;
export const MAX_EVALUATION_TIMEOUT_MS = 300_000;
export const EVALUATION_TEST_GRACE_MS = 15_000;

/** 仅未设置时使用默认值；无效配置不回退或截断，留给 harness 保存失败报告。 */
export function parseEvaluationTimeoutMs(value: unknown): number | null {
  if (value === undefined) return DEFAULT_EVALUATION_TIMEOUT_MS;
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_EVALUATION_TIMEOUT_MS ? parsed : null;
}
