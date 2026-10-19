import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEMP_PREFIX = "resume-life-backup-settings-";
const PASSWORD = "synthetic backup passphrase";
let directory = "";
let db: DatabaseSync;

async function openDevice(name: string, key: string): Promise<void> {
  db?.close();
  vi.resetModules();
  const dataDirectory = path.join(directory, name);
  fs.mkdirSync(dataDirectory, { recursive: true });
  vi.stubEnv("RESUME_LIFE_DATA_DIR", dataDirectory);
  vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", key);
  db = (await import("@/lib/db")).getDb();
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  await openDevice("source", "synthetic-source-key");
  const { writeSettings } = await import("@/lib/settings");
  writeSettings({ base_url: "https://model.invalid/v1", api_key: "sk-synthetic-source-key", api_format: "anthropic_messages", model_parse: "synthetic-model", ocr_mode: "local", proxy_password: "synthetic-source-password" });
  db.prepare("INSERT INTO bank_entries (direction, kind, question, created_at) VALUES (?, ?, ?, ?)").run("synthetic", "tech", "synthetic business data", "");
});

afterEach(() => {
  db?.close();
  db = undefined as unknown as DatabaseSync;
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error("Unsafe cleanup target");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function exportedBackup(): Promise<Buffer> {
  const { createBackupRecordStream } = await import("@/lib/backup-records");
  const { createEncryptedBackupStream } = await import("@/lib/backup-container");
  return collect(createEncryptedBackupStream(PASSWORD, createBackupRecordStream(db, new Date(), { includeSensitiveSettings: false })));
}

async function restore(bytes: Buffer, preserveAiConfig: boolean): Promise<void> {
  const { POST } = await import("@/app/api/backup/restore/route");
  const { encodeBackupPasswordHeader } = await import("@/lib/backup-container");
  const response = await POST(new Request("http://127.0.0.1/api/backup/restore", {
    method: "POST",
    headers: { "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(PASSWORD), "X-Resume-Life-Preserve-Ai-Config": String(preserveAiConfig) },
    body: new Uint8Array(bytes),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
}

describe("跨设备备份设置恢复", () => {
  it("用户导出的备份清空所有凭证、保留普通设置，并能跨设备恢复与重新保存", async () => {
    const { POST } = await import("@/app/api/backup/export/route");
    const response = await POST(new Request("http://127.0.0.1/api/backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD, confirmation: PASSWORD }) }));
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const { decryptBackupStream } = await import("@/lib/backup-container");
    const plaintext = (await collect(decryptBackupStream(PASSWORD, (async function* () { yield bytes; })()))).toString("utf8");
    const settings = plaintext.trimEnd().split("\n").map((line) => JSON.parse(line)).find((record) => record.kind === "row" && record.table === "settings").data;
    expect(settings).toMatchObject({ api_key: "", proxy_password: "", base_url: "https://model.invalid/v1", api_format: "anthropic_messages", model_parse: "synthetic-model", ocr_mode: "local" });

    await openDevice("destination", "synthetic-destination-key");
    await restore(bytes, false);
    const { readSettings, writeSettings } = await import("@/lib/settings");
    expect(readSettings()).toMatchObject({ api_key: "", proxy_password: "", model_parse: "synthetic-model" });
    writeSettings({ ...readSettings(), api_key: "sk-synthetic-destination-key", proxy_password: "synthetic-destination-password" });
    expect(readSettings()).toMatchObject({ api_key: "sk-synthetic-destination-key", proxy_password: "synthetic-destination-password" });
    expect(db.prepare("SELECT question FROM bank_entries").get()).toMatchObject({ question: "synthetic business data" });
  });

  it("preserveAiConfig=true 时完整保留目标设备配置", async () => {
    const bytes = await exportedBackup();
    await openDevice("destination", "synthetic-destination-key");
    const { readSettings, writeSettings } = await import("@/lib/settings");
    writeSettings({ base_url: "https://destination.invalid/v1", api_key: "sk-synthetic-destination-key", api_format: "openai_responses", model_parse: "destination-model", ocr_mode: "off", proxy_password: "synthetic-destination-password" });
    const before = db.prepare("SELECT * FROM settings WHERE id = 1").get();
    await restore(bytes, true);
    expect(db.prepare("SELECT * FROM settings WHERE id = 1").get()).toEqual(before);
    expect(readSettings()).toMatchObject({ api_key: "sk-synthetic-destination-key", proxy_password: "synthetic-destination-password", model_parse: "destination-model" });
  });
});
