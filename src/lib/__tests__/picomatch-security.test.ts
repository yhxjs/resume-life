import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPicomatchSecurity, runPicomatchCases } from "../../../scripts/check-picomatch-security.mjs";
import { inspectPicomatchCopies, PATCHED_SHA256 } from "../../../scripts/patch-picomatch.mjs";

describe("picomatch 实际安装副本的安全与兼容行为", () => {
  it("全部加载副本通过有限时 ReDoS 回归与常用模式检查", async () => {
    const evidence = await checkPicomatchSecurity(process.cwd());
    expect(evidence.copies.length).toBeGreaterThan(0);
    for (const copy of evidence.copies) {
      expect(copy.sha256).toBe(PATCHED_SHA256);
      expect(copy.results.length).toBeGreaterThanOrEqual(20);
    }
  });

  it("Windows/POSIX 与禁用 extglob 选项保持工具匹配行为", async () => {
    const copies = inspectPicomatchCopies(process.cwd());
    for (const copy of copies) {
      await expect(runPicomatchCases(copy.packageFile, [
        { pattern: "src/**/*.ts", input: "src\\lib\\a.ts", options: { windows: true }, expected: true },
        { pattern: "src/**/*.ts", input: "src/lib/a.ts", options: { windows: false }, expected: true },
        { pattern: "+(*a)", input: "+(*a)", options: { noextglob: true }, expected: true },
        { pattern: "+(a*b)", input: "a".repeat(128) + "c", options: { bash: true }, expected: false },
        { pattern: "+(a*b)", input: "a".repeat(128) + "c", options: { capture: true }, expected: false },
        { pattern: "**/*.test.{ts,tsx}", input: "src/lib/__tests__/test.test.ts", expected: true },
        { pattern: "**/.env*", input: "nested/.env.local", options: { dot: true }, expected: true },
        { pattern: "./.open-source-*.md", input: ".open-source-analysis.md", options: { dot: true }, expected: true },
      ])).resolves.toHaveLength(8);
    }
  });

  it("不存在的包在 worker 中报错并结束", async () => {
    await expect(runPicomatchCases(path.join(process.cwd(), "missing-picomatch/package.json")))
      .rejects.toThrow();
  });
});
