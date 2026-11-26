import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CURRENT_DB_VERSION, initializeDatabase, validateDatabaseSchema } from "../db-schema";
import { createDocumentTableProvenance } from "../document-table-provenance";
import type { BackupRecord } from "../backup-records";

const table = "resume_import_source_receipts";
const text = "[表格]\n合成材料\n[表格结束]";
const provenance = createDocumentTableProvenance(text, [{ start: 0, end: 4 }]);
let directory: string;
let database: DatabaseSync;
let source: typeof import("../resume-import-source");
let ownerHash: string;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-source-migration-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
  source = await import("../resume-import-source");
  const { token } = (await import("../auth")).createSession();
  ownerHash = createHash("sha256").update(token).digest("hex");
});
afterEach(() => {
  vi.restoreAllMocks();
  database?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-source-migration-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
function downgrade(db: DatabaseSync, version: number) {
  if (version < 7) db.exec("DROP TABLE application_preparation_plans");
  if (version < 8) db.exec("DROP TABLE project_repository_evidence; DROP TABLE mcp_upload_chunks; DROP TABLE mcp_uploads; DROP TABLE mcp_jobs; DROP TABLE mcp_work_leases; DROP TABLE mcp_operation_results; DROP TABLE mcp_generation_progress; DROP TABLE notebook_notes; DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs");
  db.exec(`DROP TABLE ${table}`);
  if (version < 5) db.exec("DROP TABLE project_material_table_provenance");
  if (version < 4) db.exec("DROP TABLE application_interview_recap_contexts");
  if (version < 3) db.exec("DROP TABLE resume_creation_requests");
  if (version < 2) db.exec("DROP TABLE salary_creation_requests");
  db.exec(`PRAGMA user_version=${version}`);
}

it.each([1, 2, 3, 4, 5])("v%s migrates real SQLite schema, filters new indexes, and preserves sessions/business rows", version => {
  database.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原稿','','')");
  downgrade(database, version);
  const sessions = database.prepare("SELECT * FROM auth_sessions").all();
  const resumes = database.prepare("SELECT * FROM resumes").all();
  expect(() => validateDatabaseSchema(database, version)).not.toThrow();
  initializeDatabase(database);
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
  expect(database.prepare("SELECT * FROM auth_sessions").all()).toEqual(sessions);
  expect(database.prepare("SELECT * FROM resumes").all()).toEqual(resumes);
  expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  const receipt = source.issueResumeImportSource(ownerHash, text, provenance);
  expect(source.resolveResumeImportSource(ownerHash, receipt.id, text)).toEqual(provenance);
  expect(() => validateDatabaseSchema(database)).not.toThrow();
});

it.each([1, 2, 3, 4, 5])("v%s failed migration atomically rolls back new runtime table and indexes", version => {
  downgrade(database, version);
  const before = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
  const execute = database.exec.bind(database);
  vi.spyOn(database, "exec").mockImplementation(sql => {
    if (sql === `PRAGMA user_version = ${CURRENT_DB_VERSION}`) throw new Error("synthetic migration failure");
    execute(sql);
  });
  expect(() => initializeDatabase(database)).toThrow("synthetic migration failure");
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
});

it("v6 validates runtime indexes and session FK and never allocates an autoincrement sequence", () => {
  const fk = database.prepare(`PRAGMA foreign_key_list(${table})`).all();
  expect(fk).toEqual([expect.objectContaining({ table: "auth_sessions", from: "owner_token_hash", to: "token_hash", on_delete: "CASCADE" })]);
  source.issueResumeImportSource(ownerHash, text, provenance);
  expect(database.prepare("SELECT * FROM sqlite_sequence WHERE name=?").get(table)).toBeUndefined();
  database.exec("DROP INDEX idx_resume_import_source_owner");
  expect(() => initializeDatabase(database)).toThrow("索引或触发器不匹配");
});

async function exported(version = CURRENT_DB_VERSION): Promise<BackupRecord[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of (await import("../backup-records")).createBackupRecordStream(database)) chunks.push(chunk);
  const records = Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line) as BackupRecord);
  const manifest = records[0];
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  const tables = (await import("../backup")).backupTablesForDbVersion(version, manifest.tables);
  const removed = records.filter(record => record.kind === "row" && !tables.includes(record.table)).length;
  return records.filter(record => record.kind !== "row" || tables.includes(record.table)).map(record => {
    if (record.kind === "manifest") return { ...record, dbVersion: version, tables, sequences: Object.fromEntries(Object.entries(record.sequences).filter(([table]) => tables.includes(table))) };
    if (record.kind === "end") return { ...record, stats: Object.fromEntries(tables.map(name => [name, record.stats[name]!])), totalRecords: record.totalRecords - removed };
    return record;
  });
}
async function stage(records: BackupRecord[]) {
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  return (await import("../backup-staging")).stageBackupRecordStream((async function* () { yield bytes; })(), database);
}

it.each([1, 2, 3, 4, 5, 6, 7])("v%s business backup excludes source receipts and restore invalidates them while preserving login", async version => {
  const receipt = source.issueResumeImportSource(ownerHash, text, provenance);
  const { TABLES_CLEAR_ORDER, TABLES_INSERT_ORDER, AUTOINCREMENT_TABLES, restoreAllData } = await import("../backup");
  expect(TABLES_CLEAR_ORDER).not.toContain(table);
  expect(TABLES_INSERT_ORDER).not.toContain(table);
  expect(AUTOINCREMENT_TABLES).not.toContain(table);
  const sessions = database.prepare("SELECT * FROM auth_sessions").all();
  const records = await exported(version);
  expect(records[0]).toMatchObject({ kind: "manifest", dbVersion: version });
  expect(JSON.stringify(records)).not.toContain(table);
  expect(JSON.stringify(records)).not.toContain(receipt.id);
  expect(JSON.stringify(records)).not.toContain(ownerHash);
  const staged = await stage(records);
  try { restoreAllData(staged, true); } finally { staged.dispose(); }
  expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  expect(database.prepare("SELECT * FROM auth_sessions").all()).toEqual(sessions);
  expect(() => source.resolveResumeImportSource(ownerHash, receipt.id, text)).toThrow(source.ResumeImportSourceGoneError);
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
});

it.each([1, 2, 3, 4, 5, 6, 7])("v%s cannot smuggle runtime receipt table into a user backup", async version => {
  const records = await exported(version);
  const manifest = records[0];
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  manifest.tables = [...manifest.tables, table];
  await expect(stage(records)).rejects.toThrow();
});

it("rejects undeclared runtime rows and runtime autoincrement sequences", async () => {
  const records = await exported();
  records.splice(1, 0, { kind: "row", table, data: {} });
  await expect(stage(records)).rejects.toThrow();
  const sequenceRecords = await exported();
  const manifest = sequenceRecords[0];
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  Object.assign(manifest.sequences, { [table]: 1 });
  await expect(stage(sequenceRecords)).rejects.toThrow();
});

it("failed restore rolls source receipts and generation back together", async () => {
  const receipt = source.issueResumeImportSource(ownerHash, text, provenance);
  const before = database.prepare(`SELECT * FROM ${table}`).all();
  const generation = (await import("../db")).dataGeneration();
  const staged = await stage(await exported());
  const { restoreAllData } = await import("../backup");
  let checks = 0;
  try {
    expect(() => restoreAllData(staged, true, () => {
      if (++checks === 2) throw new Error("synthetic final restore failure");
    })).toThrow("synthetic final restore failure");
  } finally { staged.dispose(); }
  expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
  expect((await import("../db")).dataGeneration()).toBe(generation);
  expect(source.resolveResumeImportSource(ownerHash, receipt.id, text)).toEqual(provenance);
});
