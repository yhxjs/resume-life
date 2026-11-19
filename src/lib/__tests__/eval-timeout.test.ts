import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEvaluationTimeoutMs } from "../../../evals/timeout";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("评测期限配置", () => {
  it.each([
    { value: undefined, expected: 60_000 },
    { value: "1", expected: 1 },
    { value: "120000", expected: 120_000 },
    { value: "300000", expected: 300_000 },
  ])("接受未设置的默认值及边界：$value", ({ value, expected }) => {
    expect(parseEvaluationTimeoutMs(value)).toBe(expected);
  });

  it.each(["", " ", " 60000", "60000 ", "0", "-1", "+1", "01", "1.5", "1e3", "150ms", "300001", "9007199254740992", 60000, null])(
    "拒绝无效期限，不静默回退：%s", value => {
      expect(parseEvaluationTimeoutMs(value)).toBeNull();
    },
  );

  it.each([
    { value: undefined, expected: 75_000 },
    { value: "120000", expected: 135_000 },
    { value: "300000", expected: 315_000 },
    { value: "invalid", expected: 75_000 },
  ])("实际 Vitest 配置预留报告时间，期限=$value", async ({ value, expected }) => {
    vi.stubEnv("PROMPT_EVAL_TIMEOUT_MS", value);
    vi.resetModules();
    const config = (await import(pathToFileURL(path.resolve("evals/vitest.config.mts")).href)).default;
    expect(config.test?.testTimeout).toBe(expected);
  });
});
