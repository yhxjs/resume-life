import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BackupPayload } from "./backup-fixture";

const contexts = "application_interview_recap_contexts";
let directory: string;
let database: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-backup-fixture-versions-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
  database.exec(`
    INSERT INTO applications (id,company,role,stage,jd,created_at,updated_at) VALUES (1,'现在公司','现在岗位','interviewing','现在 JD','','');
    INSERT INTO application_interviews (id,application_id,round_name,created_at,updated_at) VALUES (1,1,'现在轮次','','');
    INSERT INTO application_interview_recaps (id,interview_id,input_hash,questions,result,created_at)
      VALUES (1,1,'${"a".repeat(64)}','[]','{"mistakes":[],"drills":[],"resume_suggestions":[]}',''),
             (2,1,'${"b".repeat(64)}','[]','{"mistakes":[],"drills":[],"resume_suggestions":[]}','');
    INSERT INTO application_interview_recap_contexts VALUES (1,'原公司','原岗位','原轮次','');
  `);
});

afterEach(() => {
  database?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-backup-fixture-versions-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function payloadFor(version: number): Promise<BackupPayload> {
  const payload = (await import("./backup-fixture")).exportAllData();
  payload.meta.dbVersion = version;
  if (version < 7) {
    delete payload.data.application_preparation_plans;
    delete payload.meta.stats.application_preparation_plans;
  }
  if (version < 5) {
    delete payload.data.project_material_table_provenance;
    delete payload.meta.stats.project_material_table_provenance;
  }
  if (version < 4) {
    delete payload.data[contexts];
    delete payload.meta.stats[contexts];
  }
  return payload;
}

async function* recordStream(payload: BackupPayload): AsyncIterable<Buffer> {
  const { BACKUP_CONTAINER_VERSION } = await import("../backup-records");
  const tables = Object.keys(payload.data);
  const records = [
    { kind: "manifest", appName: "resume-life", backupVersion: BACKUP_CONTAINER_VERSION,
      dbVersion: payload.meta.dbVersion, createdAt: payload.meta.createdAt, tables, sequences: payload.meta.sequences, files: [] },
    ...tables.flatMap(table => payload.data[table]!.map(data => ({ kind: "row", table, data }))),
    { kind: "end", stats: payload.meta.stats, totalRecords: Object.values(payload.meta.stats).reduce((sum, count) => sum + count, 0), files: 0 },
  ];
  yield Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
}

async function stage(payload: BackupPayload) {
  return (await import("../backup-staging")).stageBackupRecordStream(recordStream(payload), database);
}

async function expectRejected(payload: BackupPayload) {
  await expect(stage(payload)).rejects.toThrow();
  expect((await import("./backup-fixture")).validateBackupPayload(payload).valid).toBe(false);
}

it.each([1, 2, 3, 4, 5, 6])("辅助器与生产流均接受完整 v%s 清单，保留原载荷和未知来源", async version => {
  const payload = await payloadFor(version);
  const before = structuredClone(payload);
  const dbBefore = database.prepare(`SELECT * FROM ${contexts}`).all();
  const staged = await stage(payload);
  try {
    const result = (await import("./backup-fixture")).validateBackupPayload(payload);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error(result.error);
    expect(result.payload).toEqual(before);
    expect(payload).toEqual(before);
    expect(staged.readTableBatch("application_interview_recaps").map(row => row.data)).toEqual(payload.data.application_interview_recaps);
    expect(staged.readTableBatch(contexts).map(row => row.data)).toEqual(version < 4 ? [] : dbBefore);
    expect(database.prepare(`SELECT * FROM ${contexts}`).all()).toEqual(dbBefore);
  } finally {
    staged.dispose();
  }
});

it.each([1, 2, 3, 4, 5, 6])("v%s 校验与恢复响应均按原清单计数，可通过设置页读取边界", async version => {
  const payload = await payloadFor(version);
  const { createEncryptedBackupStream, encodeBackupPasswordHeader } = await import("../backup-container");
  const { readBackupValidation, readBackupRestoreConfirmation } = await import("@/components/settings/backup-manager-utils");
  const password = "legacy-backup-test-password";
  const chunks: Buffer[] = [];
  for await (const chunk of createEncryptedBackupStream(password, recordStream(payload))) chunks.push(chunk);
  const encrypted = Buffer.concat(chunks);
  const request = (operation: string) => new Request(`http://localhost/api/backup/${operation}`, {
    method: "POST",
    headers: { "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(password) },
    body: new Uint8Array(encrypted),
  });
  database.exec("UPDATE applications SET company='恢复前改名' WHERE id=1");

  const validate = await import("@/app/api/backup/validate/route");
  const validationResponse = await validate.POST(request("validate"));
  expect(validationResponse.status).toBe(200);
  const validation = readBackupValidation(await validationResponse.json());
  expect(validation.manifest.dbVersion).toBe(version);
  expect(validation.manifest.tables).toEqual(Object.keys(payload.data));
  expect(validation.stats).toEqual(payload.meta.stats);
  expect(database.prepare("SELECT company FROM applications WHERE id=1").get()).toEqual({ company: "恢复前改名" });

  const restore = await import("@/app/api/backup/restore/route");
  const restoreResponse = await restore.POST(request("restore"));
  expect(restoreResponse.status).toBe(200);
  const confirmation = await restoreResponse.json();
  const snapshot = readBackupRestoreConfirmation(confirmation, validation);
  expect(fs.existsSync(snapshot)).toBe(true);
  expect(confirmation.stats).toEqual(payload.meta.stats);
  expect(database.prepare("SELECT company FROM applications WHERE id=1").get()).toEqual({ company: "现在公司" });
  expect(database.prepare(`SELECT * FROM ${contexts}`).all()).toEqual(payload.data[contexts] ?? []);
});

it.each([1, 2, 3])("v%s 不能接收新增快照表清单，即使该表为空", async version => {
  const payload = await payloadFor(4);
  payload.meta.dbVersion = version;
  payload.data[contexts] = [];
  payload.meta.stats[contexts] = 0;
  await expectRejected(payload);
});

it.each(["data", "stats", "both"])("v4 快照表缺少 %s 时与生产一致拒绝", async missing => {
  const payload = await payloadFor(4);
  if (missing !== "stats") delete payload.data[contexts];
  if (missing !== "data") delete payload.meta.stats[contexts];
  await expectRejected(payload);
});

it.each([1, 2, 3, 4, 5, 6])("v%s 不能借兼容规则省略其他业务表", async version => {
  const payload = await payloadFor(version);
  delete payload.data.jd_portraits;
  delete payload.meta.stats.jd_portraits;
  await expectRejected(payload);
});

it.each([0, 7])("辅助器与生产流均拒绝未支持的数据库版本 %s", async version => {
  const payload = await payloadFor(4);
  payload.meta.dbVersion = version;
  await expectRejected(payload);
});

it.each(["domain", "foreign-key"])("v3 兼容仍检查旧记录的 %s 完整性", async corruption => {
  const payload = await payloadFor(3);
  const recap = payload.data.application_interview_recaps![0]!;
  if (corruption === "domain") recap.result = "{}";
  else recap.interview_id = 999;
  await expectRejected(payload);
});
