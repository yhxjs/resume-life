import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = path.join(process.cwd(), "tests/support/test-artifacts.ts");
const playwrightConfig = fs.readFileSync(path.join(process.cwd(), "playwright.config.ts"), "utf8");
const uploadRouteTest = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/upload/__tests__/route.test.ts"),
  "utf8"
);
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("测试产物生命周期", () => {
  it("Vitest 上传用例使用独立数据目录并在用例后回收", () => {
    expect(uploadRouteTest).toContain('vi.stubEnv("RESUME_LIFE_DATA_DIR", dataDirectory)');
    expect(uploadRouteTest).toContain("fs.rmSync(resolved, { recursive: true, force: true })");
  });

  it("Playwright 下一轮启动前清理旧 test-results，但不配置结束后删除", () => {
    expect(playwrightConfig).toContain('globalSetup: "./tests/e2e/global-setup.ts"');
    expect(playwrightConfig).not.toContain("globalTeardown");
  });

  it("清理器只删除目标根目录中的 test-results", async () => {
    expect(fs.existsSync(helperPath)).toBe(true);
    const root = fs.mkdtempSync(path.join(process.cwd(), "test-artifact-contract-"));
    tempRoots.push(root);
    const results = path.join(root, "test-results");
    const sibling = path.join(root, "keep.txt");
    fs.mkdirSync(results);
    fs.writeFileSync(path.join(results, "stale-trace.zip"), "stale");
    fs.writeFileSync(sibling, "keep");

    const cleanupModule = await import(pathToFileURL(helperPath).href) as {
      cleanupPreviousPlaywrightResults(rootDirectory: string): void;
    };
    cleanupModule.cleanupPreviousPlaywrightResults(root);

    expect(fs.existsSync(results)).toBe(false);
    expect(fs.readFileSync(sibling, "utf8")).toBe("keep");
  });
});
