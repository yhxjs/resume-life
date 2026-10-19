import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_KEY_MASK_PREFIX } from "@/lib/settings";

/**
 * API Key 在本地 SQLite 中加密存储；本用例守住读取解密后的出口脱敏。
 * 一旦哪天有人把 readSettings() 的原样结果直接回给客户端，
 * 密钥就会顺着 GET /api/settings 流出去，而加密备份、日志白名单这些防护
 * 一条都拦不住它。
 */
const TEMP_PREFIX = "resume-life-settings-export-";
const LIVE_KEY = "sk-live-abcdefghijklmnop-4321";

let directory = "";
let db: DatabaseSync | undefined;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`Unsafe cleanup target: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function callGetSettings(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/settings/route");
  const response = await GET(
    new Request("http://127.0.0.1/api/settings", { headers: { host: "127.0.0.1" } }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /api/settings 的密钥出口脱敏", () => {
  it("返回的 api_key 只有掩码前缀加末 4 位，完整密钥不出现在响应里", async () => {
    const { writeSettings } = await import("@/lib/settings");
    writeSettings({
      base_url: "https://model.invalid/v1",
      api_key: LIVE_KEY,
      api_format: "openai_chat",
      model_parse: "fake",
      model_summary: "fake",
      model_question: "fake",
      model_evaluate: "fake",
    });

    const body = await callGetSettings();
    const returned = body.api_key as string;

    expect(returned).toBe(`${API_KEY_MASK_PREFIX}${LIVE_KEY.slice(-4)}`);
    expect(returned.length).toBe(API_KEY_MASK_PREFIX.length + 4);
    // 整体序列化后再查一次：密钥可能藏在别的字段或嵌套结构里
    expect(JSON.stringify(body)).not.toContain(LIVE_KEY);
  });

  it("未配置密钥时返回空串，不会回退成任何形式的明文", async () => {
    expect((await callGetSettings()).api_key).toBe("");
  });
});

describe("设置读取故障", () => {
  it.each([
    ["/api/settings", "@/app/api/settings/route"],
    ["/api/settings/configured", "@/app/api/settings/configured/route"],
  ])("%s 的数据库故障返回可关联的 500", async (pathname, modulePath) => {
    const originalPrepare = DatabaseSync.prototype.prepare;
    const failure = "SQLITE_IOERR: private database path";
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
      if (String(sql).includes("SELECT * FROM settings WHERE id = 1")) throw new Error(failure);
      return originalPrepare.call(this, sql);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const route = await import(/* @vite-ignore */ modulePath) as { GET: (request: Request) => Promise<Response> };
      const response = await route.GET(new Request(`http://127.0.0.1${pathname}`));
      const body = await response.json() as { error?: string; requestId?: string };

      expect(response.status).toBe(500);
      expect(body.requestId).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain(failure);
      expect(logged.mock.calls.flat().join(" ")).toContain(body.requestId);
    } finally {
      prepare.mockRestore();
      logged.mockRestore();
    }
  });
});
