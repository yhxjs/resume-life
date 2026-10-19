import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-reminder-backup-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-reminder-backup-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
const json = (url: string, body: unknown) => new Request(`http://localhost${url}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const scan = (dataDirectory = directory) => spawnSync(process.execPath, ["src/lib/check-interview-reminders.mjs"], {
  env: { ...process.env, RESUME_LIFE_DATA_DIR: dataDirectory }, encoding: "utf8", windowsHide: true,
});

async function seed() {
  const route = await import("../../app/api/applications/route");
  const response = await route.POST(json("/api/applications", { company: "保密公司", role: "岗位" }));
  expect(response.status).toBe(201);
  return (await response.json()).id as number;
}

it("API 接受的整数提醒能完成加密备份、校验和恢复往返", async () => {
  const id = await seed();
  const route = await import("../../app/api/applications/[id]/interviews/route");
  for (const reminder of [0, 15, Number.MAX_SAFE_INTEGER]) {
    const response = await route.POST(json(`/api/applications/${id}/interviews`, { round_name: "一面", reminder_minutes: reminder }), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(response.status).toBe(201);
  }
  const before = db.prepare("SELECT * FROM application_interviews ORDER BY id").all();
  const password = "synthetic backup passphrase";
  const exported = await (await import("../../app/api/backup/export/route")).POST(json("/api/backup/export", { password, confirmation: password }));
  expect(exported.status).toBe(200);
  const bytes = await exported.arrayBuffer();
  expect(bytes.byteLength).toBeGreaterThan(0);
  const { encodeBackupPasswordHeader } = await import("../backup-container");
  const upload = (action: string) => new Request(`http://localhost/api/backup/${action}`, {
    method: "POST", headers: { "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(password) }, body: bytes,
  });
  const validated = await (await import("../../app/api/backup/validate/route")).POST(upload("validate"));
  expect(validated.status).toBe(200);
  expect(await validated.json()).toMatchObject({ ok: true, stats: { application_interviews: 3 } });
  db.exec("DELETE FROM application_interviews");
  const restored = await (await import("../../app/api/backup/restore/route")).POST(upload("restore"));
  expect(restored.status).toBe(200);
  expect(db.prepare("SELECT * FROM application_interviews ORDER BY id").all()).toEqual(before);
});

it("旧值检测只输出记录标识，不修改异常值或披露正文", async () => {
  const id = await seed();
  const { createApplicationInterview } = await import("../applications");
  const round = createApplicationInterview(id, { round_name: "私密轮次", interview_time: "" });
  db.prepare("UPDATE application_interviews SET reminder_minutes = 0.5 WHERE id = ?").run(round.id);
  const before = db.prepare("SELECT * FROM application_interviews WHERE id = ?").get(round.id);
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("1 条异常提醒");
  expect(result.stdout).not.toContain("私密轮次");
  expect(result.stdout).not.toContain("保密公司");
  expect(db.prepare("SELECT * FROM application_interviews WHERE id = ?").get(round.id)).toEqual(before);
  db.prepare("UPDATE application_interviews SET reminder_minutes = 15 WHERE id = ?").run(round.id);
  expect(scan().status).toBe(0);
});

it("旧值检测遇到不存在的数据库不会创建数据目录", () => {
  const missing = path.join(directory, "not-created");
  const result = scan(missing);
  expect(result.status).toBe(0);
  expect(fs.existsSync(missing)).toBe(false);
});
