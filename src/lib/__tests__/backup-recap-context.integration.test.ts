import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CURRENT_DB_VERSION } from "../db-schema";
import { backupTablesForDbVersion } from "../backup";
import type { BackupRecord } from "../backup-records";

const contexts = "application_interview_recap_contexts";
let directory: string;
let database: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-recap-backup-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
  database.exec(`
    INSERT INTO applications (id,company,role,stage,jd,created_at,updated_at) VALUES (1,'现在公司','现在岗位','interviewing','现在 JD','','');
    INSERT INTO application_interviews (id,application_id,round_name,created_at,updated_at) VALUES (1,1,'现在轮次','','');
    INSERT INTO application_interview_recaps (id,interview_id,input_hash,questions,result,created_at)
      VALUES (1,1,'${"a".repeat(64)}','[]','{"mistakes":[],"drills":[],"resume_suggestions":[]}',''),
             (2,1,'${"b".repeat(64)}','[]','{"mistakes":[],"drills":[],"resume_suggestions":[]}','');
    INSERT INTO application_interview_recap_contexts VALUES (1,'原公司','原岗位','原轮次','原 JD');
  `);
});

afterEach(() => {
  database?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-recap-backup-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function exported(): Promise<BackupRecord[]> {
  const { createBackupRecordStream } = await import("../backup-records");
  const chunks: Buffer[] = [];
  for await (const chunk of createBackupRecordStream(database)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line) as BackupRecord);
}

function legacy(records: BackupRecord[], version: number): BackupRecord[] {
  const excluded = new Set([contexts, "project_material_table_provenance", "application_preparation_plans", "interview_question_graphs", "notebook_notes", "project_repository_evidence"]);
  const count = records.filter(record => record.kind === "row" && excluded.has(record.table)).length;
  return records.filter(record => record.kind !== "row" || !excluded.has(record.table)).map(record => {
    if (record.kind === "manifest") {
      const tables = backupTablesForDbVersion(version, record.tables);
      return { ...record, dbVersion: version, tables, sequences: Object.fromEntries(Object.entries(record.sequences).filter(([table]) => tables.includes(table))) };
    }
    if (record.kind === "end") {
      const stats = { ...record.stats };
      for (const table of excluded) delete stats[table];
      return { ...record, stats, totalRecords: record.totalRecords - count };
    }
    return record;
  });
}

async function stage(records: BackupRecord[]) {
  const { stageBackupRecordStream } = await import("../backup-staging");
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  return stageBackupRecordStream((async function* () { yield bytes; })(), database);
}

it.each([1, 2, 3])("v%s 原表清单恢复后来源仍未知，再导出为完整当前版本", async version => {
  const input = legacy(await exported(), version);
  const recaps = database.prepare("SELECT * FROM application_interview_recaps ORDER BY id").all();
  const staged = await stage(input);
  try {
    expect(staged.manifest.dbVersion).toBe(version);
    expect(staged.manifest.tables).not.toContain(contexts);
    expect(staged.stats[contexts]).toBe(0);
    expect(staged.readTableBatch(contexts)).toEqual([]);
    database.exec("INSERT INTO application_interview_recap_contexts VALUES (2,'恢复前公司','恢复前岗位','恢复前轮次','恢复前 JD')");
    const before = database.prepare(`SELECT * FROM ${contexts} ORDER BY recap_id`).all();
    const { restoreAllData } = await import("../backup");
    let checks = 0;
    expect(() => restoreAllData(staged, true, () => {
      if (++checks === 2) throw new Error("synthetic restore failure");
    })).toThrow("synthetic restore failure");
    expect(database.prepare(`SELECT * FROM ${contexts} ORDER BY recap_id`).all()).toEqual(before);

    restoreAllData(staged, true);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT * FROM application_interview_recaps ORDER BY id").all()).toEqual(recaps);
    expect(database.prepare(`SELECT * FROM ${contexts}`).all()).toEqual([]);
    const output = await exported();
    expect(output[0]).toMatchObject({ kind: "manifest", dbVersion: CURRENT_DB_VERSION });
    expect(output[0]?.kind === "manifest" && output[0].tables).toContain(contexts);
    expect(output.at(-1)).toMatchObject({ kind: "end", stats: { [contexts]: 0 } });
    const restaged = await stage(output);
    try { expect(restaged.readTableBatch(contexts)).toEqual([]); } finally { restaged.dispose(); }
  } finally {
    staged.dispose();
  }
});

it("当前版本往返保留旧来源快照和未知记录，快照不进入自增序列", async () => {
  const records = await exported();
  const manifest = records[0];
  expect(manifest?.kind).toBe("manifest");
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  expect(manifest.tables).toContain(contexts);
  expect(manifest.sequences).not.toHaveProperty(contexts);
  const staged = await stage(records);
  try {
    database.exec(`DELETE FROM ${contexts}`);
    const { restoreAllData, TABLES_CLEAR_ORDER, TABLES_INSERT_ORDER, AUTOINCREMENT_TABLES } = await import("../backup");
    expect(TABLES_CLEAR_ORDER.indexOf(contexts)).toBeLessThan(TABLES_CLEAR_ORDER.indexOf("application_interview_recaps"));
    expect(TABLES_INSERT_ORDER.indexOf(contexts)).toBeGreaterThan(TABLES_INSERT_ORDER.indexOf("application_interview_recaps"));
    expect(AUTOINCREMENT_TABLES).not.toContain(contexts);
    restoreAllData(staged, true);
    expect(database.prepare(`SELECT * FROM ${contexts}`).all()).toEqual([
      { recap_id: 1, company: "原公司", role: "原岗位", round_name: "原轮次", jd: "原 JD" },
    ]);
    expect(database.prepare("SELECT jd FROM applications").get()).toEqual({ jd: "现在 JD" });
    expect(database.prepare("SELECT id FROM application_interview_recaps ORDER BY id").all()).toEqual([{ id: 1 }, { id: 2 }]);
  } finally {
    staged.dispose();
  }
});

it.each(["manifest", "end"])("v4 缺少快照表的 %s 清单时拒绝，现库不变", async missing => {
  const records = await exported();
  for (const record of records) {
    if (missing === "manifest" && record.kind === "manifest") record.tables = record.tables.filter(table => table !== contexts);
    if (missing === "end" && record.kind === "end") delete record.stats[contexts];
  }
  const before = database.prepare(`SELECT * FROM ${contexts}`).all();
  await expect(stage(records)).rejects.toThrow(/manifest|end/);
  expect(database.prepare(`SELECT * FROM ${contexts}`).all()).toEqual(before);
});

it("不能将完整旧流仅改版本号伪装为 v4", async () => {
  const records = legacy(await exported(), 3);
  const manifest = records[0];
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  manifest.dbVersion = 4;
  await expect(stage(records)).rejects.toThrow(/manifest/);
});

it.each([1, 2, 3])("v%s 不接受额外快照清单或未登记的快照行", async version => {
  const current = await exported();
  const manifest = current[0];
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  manifest.dbVersion = version;
  await expect(stage(current)).rejects.toThrow(/manifest/);
  const input = legacy(current, version);
  const contextRow = current.find(record => record.kind === "row" && record.table === contexts)!;
  input.splice(1, 0, contextRow);
  await expect(stage(input)).rejects.toThrow(/未知表/);
});

it.each(["null", "orphan", "duplicate", "sequence"])("拒绝损坏的快照记录或序列：%s", async mode => {
  const records = await exported();
  const row = records.find(record => record.kind === "row" && record.table === contexts);
  if (row?.kind !== "row") throw new Error("Missing context row");
  if (mode === "null") row.data.jd = null;
  if (mode === "orphan") row.data.recap_id = 999;
  if (mode === "duplicate") records.splice(1, 0, structuredClone(row));
  if (mode === "sequence") {
    const manifest = records[0];
    if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
    Object.assign(manifest.sequences, { [contexts]: 1 });
  }
  await expect(stage(records)).rejects.toThrow(/不可为空|外键|约束|序列|UNIQUE constraint/);
});
