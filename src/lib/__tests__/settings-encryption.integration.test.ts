import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

let directory = "";
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-settings-encryption-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "test-settings-encryption-key");
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-settings-encryption-")) {
    throw new Error("Unsafe cleanup target");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("settings 敏感配置加密", () => {
  it("写入 SQLite 的 API key 和代理密码不是明文，读取仍还原原值", async () => {
    const { readSettings, writeSettings } = await import("@/lib/settings");
    writeSettings({
      base_url: "https://model.invalid/v1",
      api_key: "sk-test-sensitive-value",
      proxy_enabled: true,
      proxy_url: "http://127.0.0.1:8080",
      proxy_username: "proxy-user",
      proxy_password: "proxy-sensitive-value",
    });

    const stored = db.prepare("SELECT api_key, proxy_password FROM settings WHERE id = 1").get() as { api_key: string; proxy_password: string };
    expect(stored.api_key).not.toBe("sk-test-sensitive-value");
    expect(stored.proxy_password).not.toBe("proxy-sensitive-value");
    expect(readSettings()).toMatchObject({ api_key: "sk-test-sensitive-value", proxy_password: "proxy-sensitive-value" });
  });

});
