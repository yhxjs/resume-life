import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEMP_PREFIX = "resume-life-settings-validation-";
let directory = "";
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "synthetic-settings-key");
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error("Unsafe cleanup target");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function putSettings(values: Record<string, unknown>): Promise<Response> {
  const { PUT } = await import("@/app/api/settings/route");
  const { createSession, SESSION_COOKIE_NAME } = await import("@/lib/auth");
  const session = createSession();
  return PUT(new Request("http://127.0.0.1/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    body: JSON.stringify({ base_url: "https://model.invalid/v1", ...values }),
  }));
}

describe("PUT /api/settings 输入与持久化契约", () => {
  it.each([
    ["api_format", "unsupported-protocol"],
    ["api_format", 7],
    ["api_format", null],
    ["api_format", {}],
    ["api_format", ""],
    ["ocr_mode", "unsupported-ocr"],
    ["ocr_mode", false],
    ["ocr_mode", null],
    ["ocr_mode", []],
    ["ocr_mode", ""],
  ])("拒绝无效 %s=%j 且设置原值不变", async (field, value) => {
    const { writeSettings } = await import("@/lib/settings");
    writeSettings({ base_url: "https://model.invalid/v1", api_key: "sk-synthetic-existing", api_format: "anthropic_messages", ocr_mode: "local" });
    const before = db.prepare("SELECT * FROM settings WHERE id = 1").get();

    const response = await putSettings({ [field]: value, api_key: "sk-synthetic-replacement" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(field);
    expect(db.prepare("SELECT * FROM settings WHERE id = 1").get()).toEqual(before);
  });

  it("合法设置的回显与实际规范化保存值一致", async () => {
    const response = await putSettings({
      api_key: "sk-synthetic-new-key",
      api_format: " openai_responses ",
      ocr_mode: " off ",
      proxy_url: "HTTP://proxy.invalid:8080/ignored-path",
      proxy_username: "user",
      proxy_password: "synthetic-proxy-password",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    const { readSettings, maskApiKey } = await import("@/lib/settings");
    const { maskProxyPassword } = await import("@/lib/proxy-config");
    const saved = readSettings();
    expect(body).toMatchObject({ ...saved, api_key: maskApiKey(saved.api_key), proxy_password: maskProxyPassword(saved.proxy_password ?? "") });
    expect(saved).toMatchObject({ api_format: "openai_responses", ocr_mode: "off", proxy_url: "http://proxy.invalid:8080" });
  });

  it("省略枚举字段时回显实际保存的默认值", async () => {
    const response = await putSettings({ api_key: "sk-synthetic-new-key" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ api_format: "openai_chat", ocr_mode: "auto" });
  });

  it.each(["8192junk", "1.5", "1e6", [256], null, true, 0, -1])(
    "拒绝非法 max_output_tokens=%j 且保留原配置",
    async (value) => {
      const { writeSettings } = await import("@/lib/settings");
      writeSettings({ base_url: "https://model.invalid/v1", max_output_tokens: "4096" });
      const before = db.prepare("SELECT max_output_tokens FROM settings WHERE id = 1").get();

      const response = await putSettings({ max_output_tokens: value });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("最大输出 token");
      expect(db.prepare("SELECT max_output_tokens FROM settings WHERE id = 1").get()).toEqual(before);
    },
  );

  it("更换加密密钥后仍可显式替换失效的旧 API Key 与代理密码", async () => {
    const { writeSettings, readSettings } = await import("@/lib/settings");
    writeSettings({ base_url: "https://model.invalid/v1", api_key: "sk-synthetic-old-key", proxy_password: "synthetic-old-password" });
    vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "different-synthetic-key");

    const response = await putSettings({ api_key: "sk-synthetic-new-key", proxy_password: "synthetic-new-password" });

    expect(response.status).toBe(200);
    expect(readSettings()).toMatchObject({ api_key: "sk-synthetic-new-key", proxy_password: "synthetic-new-password" });
  });

  it("更换加密密钥后可显式清空失效凭证", async () => {
    const { writeSettings, readSettings } = await import("@/lib/settings");
    writeSettings({ base_url: "https://model.invalid/v1", api_key: "sk-synthetic-old-key", proxy_password: "synthetic-old-password" });
    vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "different-synthetic-key");

    expect((await putSettings({ api_key: "", proxy_password: "" })).status).toBe(200);
    expect(readSettings()).toMatchObject({ api_key: "", proxy_password: "" });
  });

  it("脱敏占位符不能静默清空不可解密的旧凭证", async () => {
    const { writeSettings, maskApiKey } = await import("@/lib/settings");
    const { maskProxyPassword } = await import("@/lib/proxy-config");
    writeSettings({ base_url: "https://model.invalid/v1", api_key: "sk-synthetic-old-key", proxy_password: "synthetic-old-password" });
    const before = db.prepare("SELECT * FROM settings WHERE id = 1").get();
    vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "different-synthetic-key");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await putSettings({ api_key: maskApiKey("sk-synthetic-old-key"), proxy_password: maskProxyPassword("synthetic-old-password") });

    expect(response.status).toBe(500);
    expect(db.prepare("SELECT * FROM settings WHERE id = 1").get()).toEqual(before);
  });

  it("同设备掩码保存仍保留有效 API Key 和代理密码", async () => {
    const { writeSettings, readSettings, maskApiKey } = await import("@/lib/settings");
    const { maskProxyPassword } = await import("@/lib/proxy-config");
    writeSettings({ base_url: "https://model.invalid/v1", api_key: "sk-synthetic-old-key", proxy_password: "synthetic-old-password" });
    const response = await putSettings({ api_key: maskApiKey("sk-synthetic-old-key"), proxy_password: maskProxyPassword("synthetic-old-password") });
    expect(response.status).toBe(200);
    expect(readSettings()).toMatchObject({ api_key: "sk-synthetic-old-key", proxy_password: "synthetic-old-password" });
  });

  it.each(["development", "production"])("%s 缺少加密密钥时提供安全、可操作的错误且不写入", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await putSettings({ api_key: "sk-synthetic-secret-not-for-response", proxy_password: "synthetic-password-not-for-response" });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("RESUME_LIFE_SETTINGS_KEY");
    expect(body.error).toContain("重启");
    expect(body.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("sk-synthetic-secret-not-for-response");
    expect(logged.mock.calls.flat().join(" ")).not.toContain("synthetic-password-not-for-response");
    expect(db.prepare("SELECT * FROM settings WHERE id = 1").get()).toBeUndefined();
  });

  it.each(["development", "production", "test"])("%s 配置密钥后可以保存加密凭证", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    const response = await putSettings({ api_key: "sk-synthetic-new-key" });
    expect(response.status).toBe(200);
    const stored = db.prepare("SELECT api_key FROM settings WHERE id = 1").get() as { api_key: string };
    expect(stored.api_key).toMatch(/^enc:v1:/u);
  });

  it("test 模式缺少显式密钥仍使用测试密钥保存凭证", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "");
    expect((await putSettings({ api_key: "sk-synthetic-new-key" })).status).toBe(200);
  });

  it.each(["development", "production"])("%s 无凭证的手动设置不要求加密密钥", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "");
    expect((await putSettings({ api_key: "", proxy_password: "" })).status).toBe(200);
  });
});
