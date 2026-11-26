import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BackupRecord } from "../backup-records";

let directory: string;
let db: DatabaseSync;
let notebookId: number;
let notes: typeof import("../notebook-storage");

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-notebook-notes-backup-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  notes = await import("../notebook-storage");
  db.exec("INSERT INTO drills (id,source,created_at) VALUES (1,'bank',''); INSERT INTO drill_questions (id,drill_id,idx,kind,question,answer,comment,reference) VALUES (1,1,0,'knowledge','原题','原答','原点评','原参考')");
  notebookId = notes.createNotebookFavorite({ source: "drill", sourceId: 1 }).id;
  notes.saveNotebookNote(notebookId, { content: "补充笔记😀\n保留原始换行。", expectedRevision: notes.getNotebookNote(notebookId).revision });
});

afterEach(() => {
  db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-notebook-notes-backup-")) throw new Error("Unsafe notes backup cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function records(): Promise<BackupRecord[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of (await import("../backup-records")).createBackupRecordStream(db)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line) as BackupRecord);
}
async function stage(input: BackupRecord[]) {
  const bytes = Buffer.from(input.map(record => JSON.stringify(record)).join("\n") + "\n");
  return (await import("../backup-staging")).stageBackupRecordStream((async function* () { yield bytes; })(), db);
}

it("backs up independent notes, restores their exact content and invalidates old revision tokens atomically", async () => {
  const before = notes.getNotebookNote(notebookId);
  const snapshot = db.prepare("SELECT * FROM notebook_entries WHERE id=?").get(notebookId);
  const staged = await stage(await records());
  try {
    expect(staged.manifest.tables).toContain("notebook_notes");
    expect(staged.manifest.tables.some(table => table.startsWith("mcp_"))).toBe(false);
    expect(staged.sequences.notebook_notes).toBeGreaterThan(0);
    const changed = notes.saveNotebookNote(notebookId, { content: "恢复前临时修改", expectedRevision: before.revision });
    const { restoreAllData } = await import("../backup");
    let checks = 0;
    expect(() => restoreAllData(staged, true, () => { if (++checks === 2) throw new Error("synthetic notes restore failure"); })).toThrow("synthetic notes restore failure");
    expect(notes.getNotebookNote(notebookId)).toEqual(changed);
    expect(restoreAllData(staged, true).success).toBe(true);
    expect(notes.getNotebookNote(notebookId).note).toEqual(before.note);
    expect(notes.getNotebookNote(notebookId).revision).not.toBe(before.revision);
    expect(() => notes.saveNotebookNote(notebookId, { content: "恢复前令牌覆盖", expectedRevision: changed.revision })).toThrow(/更新/);
    expect(db.prepare("SELECT * FROM notebook_entries WHERE id=?").get(notebookId)).toEqual(snapshot);
  } finally { staged.dispose(); }
});

it("restores a v10 backup with empty supplementary notes while preserving the original notebook snapshot", async () => {
  const input = await records();
  const absent = new Set(["notebook_notes", "project_repository_evidence"]);
  const noteRows = input.filter(record => record.kind === "row" && absent.has(record.table)).length;
  const legacy = input.filter(record => record.kind !== "row" || !absent.has(record.table)).map(record => {
    if (record.kind === "manifest") {
      const sequences = { ...record.sequences }; delete sequences.notebook_notes; delete sequences.project_repository_evidence;
      return { ...record, dbVersion: 10, tables: record.tables.filter(table => !absent.has(table)), sequences };
    }
    if (record.kind === "end") {
      const stats = { ...record.stats }; delete stats.notebook_notes; delete stats.project_repository_evidence;
      return { ...record, stats, totalRecords: record.totalRecords - noteRows };
    }
    return record;
  });
  const snapshot = db.prepare("SELECT * FROM notebook_entries WHERE id=?").get(notebookId);
  const staged = await stage(legacy);
  try {
    (await import("../backup")).restoreAllData(staged, true);
    expect(notes.getNotebookNote(notebookId).note).toBeNull();
    expect(db.prepare("SELECT * FROM notebook_entries WHERE id=?").get(notebookId)).toEqual(snapshot);
  } finally { staged.dispose(); }
});

it("rejects a backup whose supplementary note points to a missing notebook entry", async () => {
  const before = notes.getNotebookNote(notebookId);
  const tampered = (await records()).map(record => record.kind === "row" && record.table === "notebook_notes"
    ? { ...record, data: { ...record.data, notebook_id: 999 } } : record);
  await expect(stage(tampered)).rejects.toThrow();
  expect(notes.getNotebookNote(notebookId)).toEqual(before);
});

it("deletes supplementary notes when the saved notebook entry is removed", () => {
  db.prepare("DELETE FROM notebook_entries WHERE id=?").run(notebookId);
  expect(db.prepare("SELECT COUNT(*) AS n FROM notebook_notes").get()).toEqual({ n: 0 });
});
