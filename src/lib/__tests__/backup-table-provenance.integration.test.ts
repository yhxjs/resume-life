import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BackupRecord } from "../backup-records";
import { createDocumentTableProvenance } from "../document-table-provenance";
import { CURRENT_DB_VERSION, initializeDatabase, validateDatabaseSchema } from "../db-schema";

const table = "project_material_table_provenance";
const text = "[表格]\n\n原文 😀\n\n[表格结束]\n\n";
const provenance = JSON.stringify(createDocumentTableProvenance(text, [
  { start: 0, end: 4 }, { start: text.indexOf("[表格结束]"), end: text.indexOf("[表格结束]") + 6 },
]), null, 2); // Whitespace is valid; backup preserves the original stored JSON.
let directory: string;
let database: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-provenance-backup-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
  database.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'合成项目','','')");
  const insert = database.prepare("INSERT INTO project_materials (id,project_id,title,source,filename,content,created_at) VALUES (?,1,?,'file','test.docx',?,'')");
  insert.run(7, "真实表格", text);
  insert.run(11, "来源未知", text);
  insert.run(21, "不同正文", "只有普通段落");
  database.prepare(`INSERT INTO ${table} (material_id,provenance) VALUES (?,?)`).run(7, provenance);
  database.prepare(`INSERT INTO ${table} (material_id,provenance) VALUES (?,?)`)
    .run(21, JSON.stringify(createDocumentTableProvenance("只有普通段落", [])));
});

afterEach(() => {
  database?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-provenance-backup-")) {
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

async function stage(records: BackupRecord[]) {
  const { stageBackupRecordStream } = await import("../backup-staging");
  const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
  // Exercise record boundaries split inside Chinese text and the provenance JSON.
  return stageBackupRecordStream((async function* () {
    for (let offset = 0; offset < bytes.length; offset += 113) yield bytes.subarray(offset, offset + 113);
  })(), database);
}

async function legacy(records: BackupRecord[], version: number): Promise<BackupRecord[]> {
  const { backupTablesForDbVersion } = await import("../backup");
  const manifest = records[0];
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  const tables = backupTablesForDbVersion(version, manifest.tables);
  const removed = records.filter(record => record.kind === "row" && !tables.includes(record.table)).length;
  return records.filter(record => record.kind !== "row" || tables.includes(record.table)).map(record => {
    if (record.kind === "manifest") return { ...record, dbVersion: version, tables };
    if (record.kind === "end") return { ...record, stats: Object.fromEntries(tables.map(name => [name, record.stats[name]!])), totalRecords: record.totalRecords - removed };
    return record;
  });
}

it.each([1, 2, 3, 4])("v%s migration preserves material IDs and text without inventing provenance", version => {
  const old = new DatabaseSync(":memory:");
  try {
    old.exec("PRAGMA foreign_keys=ON");
    initializeDatabase(old);
    old.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (3,'旧项目','','')");
    old.prepare("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES (17,3,'旧材料',?,'')").run(text);
    old.exec(`DROP TABLE application_preparation_plans; DROP TABLE resume_import_source_receipts; DROP TABLE ${table}`);
    if (version < 4) old.exec("DROP TABLE application_interview_recap_contexts");
    if (version < 3) old.exec("DROP TABLE resume_creation_requests");
    if (version < 2) old.exec("DROP TABLE salary_creation_requests");
    old.exec(`PRAGMA user_version=${version}`);
    const materials = old.prepare("SELECT * FROM project_materials").all();
    expect(() => validateDatabaseSchema(old, version)).not.toThrow();
    initializeDatabase(old);
    expect(old.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(old.prepare("SELECT * FROM project_materials").all()).toEqual(materials);
    expect(old.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(() => validateDatabaseSchema(old)).not.toThrow();
  } finally { old.close(); }
});

it("v4 migration rolls back the new table and version together on failure", () => {
  database.exec(`DROP TABLE application_preparation_plans; DROP TABLE resume_import_source_receipts; DROP TABLE ${table}; PRAGMA user_version=4`);
  const before = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
  const execute = database.exec.bind(database);
  vi.spyOn(database, "exec").mockImplementation(sql => {
    if (sql === `PRAGMA user_version = ${CURRENT_DB_VERSION}`) throw new Error("synthetic migration failure");
    execute(sql);
  });
  expect(() => initializeDatabase(database)).toThrow("synthetic migration failure");
  expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
});

it("current backup restores exact provenance, material IDs, explicit empty markers and unknown absence", async () => {
  const records = await exported();
  expect(records[0]).toMatchObject({ kind: "manifest", dbVersion: CURRENT_DB_VERSION });
  const before = database.prepare(`SELECT * FROM ${table} ORDER BY material_id`).all();
  const staged = await stage(records);
  try {
    const { restoreAllData, TABLES_CLEAR_ORDER, TABLES_INSERT_ORDER, AUTOINCREMENT_TABLES } = await import("../backup");
    expect(TABLES_CLEAR_ORDER.indexOf(table)).toBeLessThan(TABLES_CLEAR_ORDER.indexOf("project_materials"));
    expect(TABLES_INSERT_ORDER.indexOf(table)).toBeGreaterThan(TABLES_INSERT_ORDER.indexOf("project_materials"));
    expect(AUTOINCREMENT_TABLES).not.toContain(table);
    expect(staged.sequences).not.toHaveProperty(table);
    expect(staged.readTableBatch(table).map(row => row.data)).toEqual(before);
    database.exec("DELETE FROM projects WHERE id=1");
    expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    restoreAllData(staged, true);
    expect(database.prepare(`SELECT * FROM ${table} ORDER BY material_id`).all()).toEqual(before);
    expect(database.prepare("SELECT id FROM project_materials ORDER BY id").all()).toEqual([{ id: 7 }, { id: 11 }, { id: 21 }]);
    expect(database.prepare(`SELECT provenance FROM ${table} WHERE material_id=7`).get()).toEqual({ provenance });
    expect(database.prepare(`SELECT * FROM ${table} WHERE material_id=11`).get()).toBeUndefined();
    const roundtrip = await stage(await exported());
    try { expect(roundtrip.readTableBatch(table).map(row => row.data)).toEqual(before); } finally { roundtrip.dispose(); }
  } finally { staged.dispose(); }
});

it.each([1, 2, 3, 4])("v%s backup clears prior provenance and restores old materials with unknown origin", async version => {
  const input = await legacy(await exported(), version);
  const materials = database.prepare("SELECT * FROM project_materials ORDER BY id").all();
  const staged = await stage(input);
  try {
    expect(staged.manifest.tables).not.toContain(table);
    expect(staged.stats[table]).toBe(0);
    expect(staged.readTableBatch(table)).toEqual([]);
    (await import("../backup")).restoreAllData(staged, true);
    expect(database.prepare("SELECT * FROM project_materials ORDER BY id").all()).toEqual(materials);
    expect(database.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect((await exported())[0]).toMatchObject({ dbVersion: CURRENT_DB_VERSION });
  } finally { staged.dispose(); }
});

it.each([1, 2, 3, 4])("v%s rejects the new provenance table or an undeclared provenance row", async version => {
  const current = await exported();
  const input = await legacy(current, version);
  const manifest = current[0];
  if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
  manifest.dbVersion = version;
  await expect(stage(current)).rejects.toThrow(/manifest/);
  input.splice(1, 0, current.find(row => row.kind === "row" && row.table === table)!);
  await expect(stage(input)).rejects.toThrow(/未知表/);
});

it.each(["manifest", "end"])("v5 requires the provenance table in the %s even when empty", async missing => {
  database.exec(`DELETE FROM ${table}`);
  const records = await exported();
  for (const record of records) {
    if (missing === "manifest" && record.kind === "manifest") record.tables = record.tables.filter(name => name !== table);
    if (missing === "end" && record.kind === "end") delete record.stats[table];
  }
  await expect(stage(records)).rejects.toThrow(/manifest|end/);
});

it.each(["json", "extra", "hash", "range", "overlap", "surrogate", "binding", "null", "orphan", "duplicate", "sequence"])(
  "rejects corrupt provenance before changing the destination: %s", async mode => {
    const records = await exported();
    const row = records.find(record => record.kind === "row" && record.table === table && record.data.material_id === 7);
    if (row?.kind !== "row") throw new Error("Missing provenance row");
    const value = JSON.parse(provenance);
    if (mode === "json") row.data.provenance = "{";
    if (mode === "extra") row.data.provenance = JSON.stringify({ ...value, trusted: true });
    if (mode === "hash") row.data.provenance = JSON.stringify({ ...value, textSha256: "a".repeat(64) });
    if (mode === "range") row.data.provenance = JSON.stringify({ ...value, markers: [{ start: 0, end: text.length + 1 }] });
    if (mode === "overlap") row.data.provenance = JSON.stringify({ ...value, markers: [{ start: 0, end: 4 }, { start: 2, end: 4 }] });
    if (mode === "surrogate") row.data.provenance = JSON.stringify({ ...value, markers: [{ start: text.indexOf("😀"), end: text.indexOf("😀") + 1 }] });
    if (mode === "binding") {
      // Keep a valid foreign key and row count but replace the bound material text.
      const material = records.find(record => record.kind === "row" && record.table === "project_materials" && record.data.id === 7);
      if (material?.kind !== "row") throw new Error("Missing material");
      material.data.content = "另一份正文";
    }
    if (mode === "null") row.data.provenance = null;
    if (mode === "orphan") row.data.material_id = 999;
    if (mode === "duplicate") records.splice(1, 0, structuredClone(row));
    if (mode === "sequence") {
      const manifest = records[0];
      if (manifest?.kind !== "manifest") throw new Error("Missing manifest");
      Object.assign(manifest.sequences, { [table]: 7 });
    }
    const before = database.prepare(`SELECT * FROM ${table} ORDER BY material_id`).all();
    await expect(stage(records)).rejects.toThrow();
    expect(database.prepare(`SELECT * FROM ${table} ORDER BY material_id`).all()).toEqual(before);
  },
);

it("validate and restore reject an uploaded text/hash mismatch with HTTP 400", async () => {
  const records = await exported();
  const row = records.find(record => record.kind === "row" && record.table === "project_materials" && record.data.id === 7);
  if (row?.kind !== "row") throw new Error("Missing material");
  row.data.content = "modified upload text";
  const { createEncryptedBackupStream, encodeBackupPasswordHeader } = await import("../backup-container");
  const password = "synthetic backup passphrase";
  const chunks: Buffer[] = [];
  const plaintext = (async function* () { for (const record of records) yield Buffer.from(JSON.stringify(record) + "\n"); })();
  for await (const chunk of createEncryptedBackupStream(password, plaintext)) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const validate = await import("@/app/api/backup/validate/route");
  const restore = await import("@/app/api/backup/restore/route");
  for (const [name, route] of [["validate", validate], ["restore", restore]] as const) {
    const response = await route.POST(new Request(`http://localhost/api/backup/${name}`, {
      method: "POST", body: bytes, headers: { "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(password) },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: expect.stringContaining("material_id=7") });
  }
  expect(database.prepare("SELECT content FROM project_materials WHERE id=7").get()).toEqual({ content: text });
});

it("export refuses stale stored provenance instead of emitting an apparently valid backup", async () => {
  database.prepare("UPDATE project_materials SET content=? WHERE id=7").run("正文已变");
  await expect(exported()).rejects.toThrow(/表格来源/);
});

it("restore rechecks text binding and rolls back an altered staging handle", async () => {
  const staged = await stage(await exported());
  const { restoreAllData } = await import("../backup");
  const before = database.prepare(`SELECT * FROM ${table} ORDER BY material_id`).all();
  try {
    const altered = { ...staged, readTableBatch(name: string, after?: number, limit?: number) {
      return staged.readTableBatch(name, after, limit).map(row => name === "project_materials" && row.data.id === 7
        ? { ...row, data: { ...row.data, content: "恢复途中被改写" } } : row);
    } };
    expect(() => restoreAllData(altered, true)).toThrow(/表格来源/);
    expect(database.prepare(`SELECT * FROM ${table} ORDER BY material_id`).all()).toEqual(before);
    expect(database.prepare("SELECT content FROM project_materials WHERE id=7").get()).toEqual({ content: text });
  } finally { staged.dispose(); }
});
