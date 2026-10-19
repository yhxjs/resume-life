import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-route-write-generation-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("@/lib/db")).getDb();
  db.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'Original','','')").run();
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-route-write-generation-")) {
    throw new Error("Unsafe cleanup");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("ordinary route writes across a restore lock", () => {
  it.each(["PATCH", "DELETE"] as const)("rejects stale client %s sent after a real restore has completed", async (method) => {
    const { dataGeneration } = await import("@/lib/db");
    const { createBackupRecordStream } = await import("@/lib/backup-records");
    const { stageBackupRecordStream } = await import("@/lib/backup-staging");
    const { restoreAllData } = await import("@/lib/backup");
    const { PATCH, DELETE } = await import("@/app/api/projects/[id]/route");
    const oldGeneration = dataGeneration(db) ?? "initial";
    const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
    try {
      db.prepare("UPDATE projects SET name='Current' WHERE id=1").run();
      restoreAllData(staged, true);
    } finally { staged.dispose(); }
    expect(dataGeneration(db)).not.toBe(oldGeneration);
    const route = method === "PATCH" ? PATCH : DELETE;
    const request = (generation: string) => new Request("http://localhost/api/projects/1", {
      method, headers: { "Content-Type": "application/json", "X-Resume-Life-Data-Generation": generation },
      ...(method === "PATCH" ? { body: JSON.stringify({ name: "Changed" }) } : {}),
    });
    expect((await route(request(oldGeneration), { params: Promise.resolve({ id: "1" }) })).status).toBe(409);
    expect(db.prepare("SELECT name FROM projects WHERE id=1").get()).toEqual({ name: "Original" });
    expect((await route(request(dataGeneration(db)!), { params: Promise.resolve({ id: "1" }) })).status).toBe(200);
  });

  it("rejects a native browser mutation without its document generation", async () => {
    const { DELETE } = await import("@/app/api/projects/[id]/route");
    const response = await DELETE(new Request("http://localhost/api/projects/1", {
      method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" },
    }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(409);
    expect(db.prepare("SELECT name FROM projects WHERE id=1").get()).toEqual({ name: "Original" });
  });

  it.each(["PATCH", "DELETE"] as const)("rejects project %s before changing a row restored while waiting for the write lock", async (method) => {
    const { PATCH, DELETE } = await import("@/app/api/projects/[id]/route");
    const locked = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(workerData);
      database.exec('BEGIN IMMEDIATE');
      database.prepare("UPDATE projects SET name='Restored' WHERE id=1").run();
      database.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored')").run();
      parentPort.postMessage('locked');
      parentPort.once('message', () => setTimeout(() => {
        database.exec('COMMIT'); database.close(); parentPort.close();
      }, 100));
    `, { eval: true, workerData: path.join(directory, "data", "resume-life.db") });
    worker.once("message", () => locked.resolve());
    worker.once("error", (error) => { locked.reject(error); exited.reject(error); });
    worker.once("exit", () => exited.resolve());
    try {
      await locked.promise;
      const route = method === "PATCH" ? PATCH : DELETE;
      const pending = route(new Request("http://localhost/api/projects/1", {
        method,
        ...(method === "PATCH" ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Old request" }),
        } : {}),
      }), { params: Promise.resolve({ id: "1" }) });
      worker.postMessage("release");
      expect((await pending).status).toBe(409);
      expect(db.prepare("SELECT name FROM projects WHERE id=1").get()).toEqual({ name: "Restored" });
      await exited.promise;
    } finally {
      await worker.terminate();
    }
  });
});
