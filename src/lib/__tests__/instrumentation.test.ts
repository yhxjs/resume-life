import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onRequestError, register } from "../../instrumentation";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("仅 Node.js 运行时记录启动环境摘要", async () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubEnv("NEXT_RUNTIME", "edge");
  await register();
  expect(output).not.toHaveBeenCalled();

  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  await register();
  expect(String(output.mock.calls[0]?.[0])).toContain('"operation":"startup"');
  expect(String(output.mock.calls[0]?.[0])).toContain('"node":');
});

it("Node.js 启动时清理已过期且所属进程已退出的恢复暂存目录", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-restore-"));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.writeFileSync(path.join(directory, ".owner"), JSON.stringify({ pid: 999_999_999, createdAt: old.getTime() }));
  fs.writeFileSync(path.join(directory, "staging.db"), "synthetic private data");
  fs.utimesSync(directory, old, old);
  try {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.spyOn(console, "info").mockImplementation(() => {});
    await register();
    expect(fs.existsSync(directory)).toBe(false);
  } finally {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-restore-")) {
      throw new Error("Unsafe test cleanup path");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("框架未处理异常沿用已校验的请求关联 ID", () => {
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  const context = { routePath: "/", routeType: "render", routerKind: "App Router", renderSource: "react-server-components" } as Parameters<typeof onRequestError>[2];
  onRequestError(new Error("private-data"), { path: "/", method: "GET", headers: { "X-Request-Id": "req-framework-safe" } }, context);
  expect(String(output.mock.calls[0]?.[0])).toContain('"requestId":"req-framework-safe"');
  output.mockClear();
  onRequestError(new Error("private-data"), { path: "/", method: "GET", headers: { "x-request-id": "<unsafe>" } }, context);
  expect(String(output.mock.calls[0]?.[0])).not.toContain("<unsafe>");
});
