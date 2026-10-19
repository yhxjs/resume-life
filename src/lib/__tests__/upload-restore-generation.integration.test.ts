import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const hooks = vi.hoisted(() => ({ saved: vi.fn() }));
vi.mock("../upload-storage", async (original) => {
  const actual = await original<typeof import("../upload-storage")>();
  return { ...actual, saveUploadFile: async (...args: Parameters<typeof actual.saveUploadFile>) => {
    const result = await actual.saveUploadFile(...args);
    await hooks.saved();
    return result;
  } };
});
let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  hooks.saved.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-upload-generation-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'Synthetic','','')").run();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-upload-generation-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

it("does not sweep an avatar restored while an upload is waiting to finish", async () => {
  const target = path.join(directory, "uploads", "restored.png");
  fs.mkdirSync(path.dirname(target));
  fs.writeFileSync(target, "Old orphan");
  fs.utimesSync(target, new Date(0), new Date(0));
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  const { POST } = await import("@/app/api/upload/route");
  const locked = Promise.withResolvers<void>();
  const committed = new SharedArrayBuffer(4);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const database = new DatabaseSync(workerData.database);
    database.exec('BEGIN IMMEDIATE');
    database.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored')").run();
    database.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES (1,'basic','basic','Basic',0,?,'')")
      .run(JSON.stringify({avatar:'/api/uploads/restored.png'}));
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => {
      fs.writeFileSync(workerData.target + '.incoming', 'Restored avatar');
      fs.renameSync(workerData.target + '.incoming', workerData.target);
      database.exec('COMMIT'); database.close();
      const state = new Int32Array(workerData.committed);
      Atomics.store(state, 0, 1); Atomics.notify(state, 0); parentPort.close();
    }, 100));
  `, { eval: true, workerData: { database: path.join(directory, "resume-life.db"), target, committed } });
  worker.once("message", () => locked.resolve());
  worker.once("error", locked.reject);
  try {
    await locked.promise;
    hooks.saved.mockImplementationOnce(() => worker.postMessage("release"));
    const stat = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      const result = stat(...args);
      if (args[0] === target) Atomics.wait(new Int32Array(committed), 0, 0, 10_000);
      return result;
    }) as typeof fs.statSync);
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], "synthetic.png", { type: "image/png" }));
    expect((await POST(new Request("http://localhost/api/upload", { method: "POST", body: form }))).status).toBe(409);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("Restored avatar");
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id=1").get()).toEqual({ content: '{"avatar":"/api/uploads/restored.png"}' });
  } finally {
    await worker.terminate();
  }
});
