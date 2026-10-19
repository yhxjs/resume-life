import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-styles-generate-route-test-";

let tempDir: string;
let db: DatabaseSync | undefined;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Windows 上删除仍被 SQLite 持有的文件会 EPERM，必须先关句柄
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Unsafe cleanup path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

const request = (body?: unknown) =>
  new Request("http://127.0.0.1/api/styles/generate", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("POST /api/styles/generate 样式生成", () => {
  it("描述为空返回 400", async () => {
    const route = await import("../route");
    const res = await route.POST(request({ prompt: "" }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("请先描述你想要的模板风格");
  });

  it("描述超过 500 字返回 400", async () => {
    const route = await import("../route");
    const res = await route.POST(request({ prompt: "色".repeat(501) }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("风格描述不能超过 500 字");
  });

  it("LLM 未配置时走安全失败路径返回 502，不真正调用模型", async () => {
    // 空库的 settings 表全空，safeChat 会在发起任何网络请求前抛 LlmConfigError
    const settings = db?.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number } | undefined;
    expect(settings?.n).toBe(0);

    const route = await import("../route");
    const res = await route.POST(request({ prompt: "深色简约风格，衬线字体" }));
    expect(res.status).toBe(502);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("尚未配置好");
    expect(data.error).toContain("LLM");
  });
});
