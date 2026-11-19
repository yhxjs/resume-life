import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-resume-requests-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});
afterEach(() => {
  db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-resume-requests-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});
const input = { title: "导入原稿", modules: { summary: { text: "未上线 Array&lt;T&gt; &amp;amp;", descriptionItems: ["未上线 Array&lt;T&gt; &amp;amp;"] } } };
async function post(key: string | null, body: unknown = input) {
  const { POST } = await import("@/app/api/resumes/route");
  return POST(new Request("http://localhost/api/resumes", { method: "POST",
    headers: { "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }) }, body: JSON.stringify(body) }));
}
async function read(requestId: string) {
  const { GET } = await import("@/app/api/resumes/requests/[requestId]/route");
  return GET(new Request(`http://localhost/api/resumes/requests/${requestId}`), { params: Promise.resolve({ requestId }) });
}

describe("简历创建的持久请求回执", () => {
  it("同编号重放只写一份，重启后仍返回原 ID，同文新编号允许另建", async () => {
    const key = randomUUID();
    const first = await post(key); expect(first.status).toBe(201);
    const result = await first.json();
    expect(await (await read(key)).json()).toEqual({ request_id: key, status: "succeeded", id: result.id });
    expect((await read(key)).headers.get("Cache-Control")).toBe("no-store");
    const repeat = await post(key); expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(result);
    expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 1 });
    db.close(); vi.resetModules(); db = (await import("../db")).getDb();
    expect(await (await post(key)).json()).toEqual(result);
    expect((await post(randomUUID())).status).toBe(201);
    expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 2 });
    const receipt = db.prepare("SELECT * FROM resume_creation_requests WHERE request_id=?").get(key)!;
    expect(receipt.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(receipt).join(" ")).not.toContain("未上线");
  });
  it("同时提交同编号只创建一份；字段顺序与标题边缘空白不产生新命令", async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([post(key), post(key)]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(await first.json()).toEqual(await second.json());
    const reordered = { modules: { summary: { descriptionItems: input.modules.summary.descriptionItems, text: input.modules.summary.text } }, title: `  ${input.title}  ` };
    expect((await post(key, reordered)).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM resume_modules").get()).toEqual({ n: 6 });
  });
  it.each([false, true])("另一 SQLite 连接提交回执期间重复请求等锁后重验，恢复世代变化=%s", async restored => {
    const key = randomUUID(); const original = await (await post(key)).json();
    const row = db.prepare("SELECT * FROM resume_creation_requests WHERE request_id=?").get(key)!;
    db.prepare("DELETE FROM resume_creation_requests WHERE request_id=?").run(key);
    const locked = Promise.withResolvers<void>(); const exited = Promise.withResolvers<void>();
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(workerData.path);
      database.exec('BEGIN IMMEDIATE');
      const row = workerData.row;
      database.prepare('INSERT INTO resume_creation_requests (request_id,input_hash,resume_id,created_at) VALUES (?,?,?,?)').run(row.request_id,row.input_hash,row.resume_id,row.created_at);
      if (workerData.restored) database.exec("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored')");
      parentPort.postMessage('locked');
      parentPort.once('message', () => setTimeout(() => {
        database.exec('COMMIT'); database.close(); parentPort.close();
      }, 100));
    `, { eval: true, workerData: { path: path.join(directory, "resume-life.db"), row, restored } });
    worker.once("message", () => locked.resolve());
    worker.once("error", error => { locked.reject(error); exited.reject(error); });
    worker.once("exit", () => exited.resolve());
    try {
      await locked.promise;
      const pending = post(key); worker.postMessage("release");
      const response = await pending;
      expect(response.status).toBe(restored ? 409 : 200);
      if (!restored) expect(await response.json()).toEqual(original);
      expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT * FROM resume_creation_requests WHERE request_id=?").get(key)).toEqual(row);
      await exited.promise;
    } finally { await worker.terminate(); }
  });
  it("同编号修改正文、富文本或数组顺序均拒绝，不能覆盖原简历", async () => {
    const key = randomUUID(); await post(key);
    for (const text of ["另一稿", "未上线 Array<T> &amp;", `${input.modules.summary.text} `]) {
      expect((await post(key, { ...input, modules: { summary: { text } } })).status).toBe(409);
    }
    expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 1 });
    const key2 = randomUUID(); const ordered = { title: "顺序", modules: { skills: { items: ["SQL", "TypeScript"] } } };
    await post(key2, ordered);
    expect((await post(key2, { ...ordered, modules: { skills: { items: ["TypeScript", "SQL"] } } })).status).toBe(409);
  });
  it.each(["", "bad", "1", "../escape", "a".repeat(200)])("拒绝无效编号 %j，不写简历或回执", async key => {
    expect((await post(key)).status).toBe(400); expect((await read(key)).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT * FROM resume_creation_requests").all()).toEqual([]);
  });
  it("简历删除保留墓碑，重放不会复活；未知编号只读返回 404", async () => {
    const key = randomUUID(); const { id } = await (await post(key)).json();
    db.prepare("DELETE FROM resumes WHERE id=?").run(id);
    expect(await (await read(key)).json()).toEqual({ request_id: key, status: "deleted" });
    expect((await post(key)).status).toBe(410);
    expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 0 });
    expect((await read(randomUUID())).status).toBe(404);
  });
  it.each(["module", "receipt"])("%s 写入失败时回滚简历、模块和回执，同编号可安全重试", async mode => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const key = randomUUID();
    db.exec(`CREATE TRIGGER synthetic_fail BEFORE INSERT ON ${mode === "module" ? "resume_modules" : "resume_creation_requests"} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    expect((await post(key)).status).toBe(500);
    for (const table of ["resumes", "resume_modules", "resume_creation_requests"]) expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    expect((await read(key)).status).toBe(404);
    db.exec("DROP TRIGGER synthetic_fail");
    expect((await post(key)).status).toBe(201);
    expect((await post(key)).status).toBe(200);
  });
  it("不带编号的旧调用仍可创建，输入无效不占用编号", async () => {
    expect((await post(null)).status).toBe(201);
    expect(db.prepare("SELECT * FROM resume_creation_requests").all()).toEqual([]);
    const key = randomUUID();
    expect((await post(key, { title: "" })).status).toBe(400);
    expect((await read(key)).status).toBe(404);
    expect((await post(key)).status).toBe(201);
    expect((await post(key, { title: input.title, modules: null })).status).toBe(400);
  });
  it.each([1, 2, 3])("v%s 业务备份兼容；回执不导出，恢复失败保留，成功恢复清除", async version => {
    const key = randomUUID(); const { id } = await (await post(key)).json();
    const { createBackupRecordStream } = await import("../backup-records");
    const chunks: Buffer[] = []; for await (const chunk of createBackupRecordStream(db)) chunks.push(Buffer.from(chunk));
    const records = Buffer.concat(chunks).toString().trim().split("\n").map(line => JSON.parse(line));
    expect(records[0].tables).not.toContain("resume_creation_requests");
    expect(records.some(record => record.table === "resume_creation_requests")).toBe(false);
    records[0].dbVersion = version;
    records[0].tables = records[0].tables.filter((table: string) => table !== "application_interview_recap_contexts" && table !== "project_material_table_provenance");
    delete records.at(-1).stats.application_interview_recap_contexts;
    delete records.at(-1).stats.project_material_table_provenance;
    const { stageBackupRecordStream } = await import("../backup-staging");
    const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const staged = await stageBackupRecordStream((async function* () { yield bytes; })(), db);
    const { restoreAllData } = await import("../backup");
    try {
      let checks = 0;
      expect(() => restoreAllData(staged, true, () => { if (++checks === 2) throw new Error("synthetic deadline"); })).toThrow("synthetic deadline");
      expect(await (await read(key)).json()).toMatchObject({ status: "succeeded", id });
      restoreAllData(staged, true);
      expect((await read(key)).status).toBe(404);
      expect(db.prepare("SELECT id FROM resumes").all()).toEqual([{ id }]);
    } finally { staged.dispose(); }
  });
});
