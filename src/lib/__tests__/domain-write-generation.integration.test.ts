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
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-domain-generation-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'Synthetic','',''); INSERT INTO applications (id,company,role,stage,created_at,updated_at) VALUES (1,'Original','Synthetic','interested','',''); INSERT INTO application_interviews (id,application_id,round_name,created_at,updated_at) VALUES (1,1,'Original','',''); INSERT INTO intros (id,resume_id,jd,created_at) VALUES (1,1,'Synthetic',''); INSERT INTO settings (id,base_url) VALUES (1,'https://original.invalid/v1')");
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-domain-generation-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

const cases = ["delete application", "sync interview time", "create interview", "update interview", "delete interview", "link preparation", "create task", "write settings", "save defense"] as const;
describe("domain write locks across restore", () => {
  it.each(cases)("rejects %s without changing restored data", async (kind) => {
    const applications = await import("../applications");
    const preparation = await import("../application-preparation");
    const settings = await import("../settings");
    const defense = await import("../resume-defense");
    const { withRouteErrorHandling } = await import("../api-route");
    const mutations: Record<typeof cases[number], () => unknown> = {
      "delete application": () => applications.deleteApplication(1),
      "sync interview time": () => applications.syncApplicationNextInterview(1),
      "create interview": () => applications.createApplicationInterview(1, { round_name: "Old round" }),
      "update interview": () => applications.updateApplicationInterview(1, { round_name: "Old round" }),
      "delete interview": () => applications.deleteApplicationInterview(1),
      "link preparation": () => preparation.linkPreparationResource(1, "intro", 1),
      "create task": () => preparation.createPreparationTask(1, "Old task"),
      "write settings": () => settings.writeSettings({ base_url: "https://old.invalid/v1" }),
      "save defense": () => defense.saveDefenseReport({ sourceContent: "Old content", riskLevel: "low", overallRoast: "Old report", items: [] }),
    };
    const locked = Promise.withResolvers<void>();
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(workerData);
      database.exec('BEGIN IMMEDIATE');
      database.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored')").run();
      database.prepare("UPDATE applications SET company='Restored',next_interview_at='Restored time' WHERE id=1").run();
      database.prepare("UPDATE application_interviews SET round_name='Restored round' WHERE id=1").run();
      database.prepare("UPDATE settings SET base_url='https://restored.invalid/v1' WHERE id=1").run();
      parentPort.postMessage('locked');
      parentPort.once('message', () => setTimeout(() => {
        database.exec('COMMIT'); database.close(); parentPort.close();
      }, 100));
    `, { eval: true, workerData: path.join(directory, "resume-life.db") });
    worker.once("message", () => locked.resolve());
    worker.once("error", locked.reject);
    try {
      await locked.promise;
      const route = withRouteErrorHandling("POST /api/audit/domain", () => {
        worker.postMessage("release");
        mutations[kind]();
        return Response.json({ ok: true });
      });
      expect((await route(new Request("http://localhost/api/audit/domain", { method: "POST" }))).status).toBe(409);
      expect(db.prepare("SELECT company,next_interview_at FROM applications").all()).toEqual([{ company: "Restored", next_interview_at: "Restored time" }]);
      expect(db.prepare("SELECT round_name FROM application_interviews").all()).toEqual([{ round_name: "Restored round" }]);
      expect(db.prepare("SELECT base_url FROM settings").get()).toEqual({ base_url: "https://restored.invalid/v1" });
      for (const table of ["application_preparation_resources", "application_preparation_tasks", "resume_defenses"]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      await worker.terminate();
    }
  });
});
