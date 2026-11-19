import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chatStream: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
let directory: string;
let db: DatabaseSync;
let versionId: number;
beforeEach(async () => {
  vi.resetModules();
  model.chatStream.mockReset().mockResolvedValue('{"question":"请介绍一项你实际参与的任务。"}');
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-interview-config-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'材料原稿','','')");
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "指定旧版" }).id;
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-interview-config-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});
const request = (body: unknown) => new Request("http://localhost/api/interviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

for (const mode of ["single", "series"]) {
  it.each([null, 0, -1, 31, 1.5, "8", "", true, [], {}, Number.MAX_SAFE_INTEGER + 1])(`${mode} 题数 %j 明确拒绝，零模型调用和零存档`, async (rounds) => {
    const { POST } = await import("@/app/api/interviews/route");
    const response = await POST(request({ resume_id: 1, resume_version_id: versionId, jd: "仅接口联调", mode, rounds }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "题数须为 1–30 的整数" });
    expect(model.chatStream).not.toHaveBeenCalled();
    for (const table of ["interviews", "interview_series", "interview_turns"]) expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
  });

  it.each([undefined, 1, 30])(`${mode} 题数 %j 按约定保存，只有省略值使用默认八题`, async (rounds) => {
    const { POST } = await import("@/app/api/interviews/route");
    const response = await POST(request({ resume_id: 1, resume_version_id: versionId, jd: "仅接口联调", mode, ...(rounds === undefined ? {} : { rounds }) }));
    const events = await response.text();
    expect(events).toContain("event: done");
    expect(events).not.toContain("event: error");
    expect(model.chatStream).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT rounds,resume_version_id FROM interviews").get()).toEqual({ rounds: rounds ?? 8, resume_version_id: versionId });
    if (mode === "series") expect(db.prepare("SELECT rounds,resume_version_id FROM interview_series").get()).toEqual({ rounds: rounds ?? 8, resume_version_id: versionId });
  });
}
