import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Bag = Record<string, unknown>;
type Page = { total: number; revision: string; domains: string[]; items: { id: number; domain: string; title: string; snippet: string }[]; nextCursor: string | null };
let directory: string, db: DatabaseSync, writer: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer;
const bankPermissions = ["search_records_page", "list_bank_entries", "read_record_section"];
const query = "RuntimeNeedle";

async function connect(allowlist: string[] = bankPermissions) {
  await client?.close(); await server?.close();
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist: new Set(allowlist), writeEnabled: false, llmEnabled: false, timeoutMs: 30_000 });
  client = new Client({ name: "search-runtime", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
async function page(args: Bag = {}): Promise<Page> {
  const result = await client.callTool({ name: "search_records_page", arguments: { query, limit: 25, ...args } });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return (result.structuredContent as { data: Page }).data;
}
async function fails(args: Bag, code = "CONFLICT") {
  const result = await client.callTool({ name: "search_records_page", arguments: { query, limit: 25, ...args } });
  expect(result.structuredContent).toMatchObject({ ok: false, error: { code } });
}
/** Count actual COUNT executions, not only prepares, and retain SQL for verifying source authorization. */
function traceCounts() {
  let executions = 0;
  const queries: string[] = [], prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith("WITH documents")) {
      queries.push(sql);
      if (/SELECT COUNT\(\*\) AS count/.test(sql)) {
        const get = statement.get;
        vi.spyOn(statement, "get").mockImplementation(function (this: typeof statement, ...args) { executions++; return get.apply(this, args); });
      }
    }
    return statement;
  });
  return { executions: () => executions, queries };
}

beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-search-runtime-")); vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  const insert = db.prepare("INSERT INTO bank_entries(id,kind,question,created_at) VALUES(?,'tech',?,'2026-11-26T00:00:00.000Z')");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let id = 1; id <= 137; id++) insert.run(id, query + " question " + id);
    insert.run(138, "A nonmatching record");
    db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'hidden-project','','')");
    db.exec("INSERT INTO applications(id,company,role,stage,jd,notes,created_at,updated_at) VALUES(1,'RuntimeNeedle','role','applied','JD','','',''),(2,'RuntimeNeedle','role','applied','JD','','',''),(3,'hidden','role','interested','JD','','','')");
    db.exec("INSERT INTO notebook_entries(id,source,source_id,question,created_at,updated_at) VALUES(1,'drill',1,'RuntimeNeedle question','',''),(2,'drill',2,'RuntimeNeedle question','','')");
    db.exec("INSERT INTO notebook_notes(notebook_id,content,created_at,updated_at) VALUES(1,'unmatched note','','')");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  writer.exec("PRAGMA busy_timeout=100"); writer.exec("PRAGMA foreign_keys=ON");
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); vi.restoreAllMocks(); writer?.close(); db?.close(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-search-runtime-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("executes one COUNT for every page of an unchanged query, including a reconnect and different limit", async () => {
  const trace = traceCounts(), first = await page();
  expect(trace.executions()).toBe(1);
  expect(first).toMatchObject({ total: 137, domains: ["bank_entry"] });
  const ids = first.items.map(row => row.id);
  let cursor = first.nextCursor;
  while (cursor) { const next = await page({ cursor }); expect(next.total).toBe(137); ids.push(...next.items.map(row => row.id)); cursor = next.nextCursor; }
  expect(ids).toEqual(Array.from({ length: 137 }, (_, i) => 137 - i));
  await connect();
  expect((await page({ cursor: first.nextCursor, limit: 7 })).items.map(row => row.id)).toEqual([112, 111, 110, 109, 108, 107, 106]);
  await page({ limit: 50 });
  expect(trace.executions()).toBe(1);
  expect(trace.queries.every(sql => sql.includes("bank_entries") && !sql.includes("applications"))).toBe(true);
});

it("refreshes an expired COUNT once without invalidating an otherwise unchanged cursor", async () => {
  const trace = traceCounts(), first = await page(), originalNow = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(originalNow + 61_001);
  const second = await page({ cursor: first.nextCursor });
  expect(second.revision).toBe(first.revision); expect(second.total).toBe(137); expect(trace.executions()).toBe(2);
  await page({ cursor: second.nextCursor }); expect(trace.executions()).toBe(2);
});

it("unauthorized domain inserts, updates and deletes neither invalidate cursors nor repeat COUNT", async () => {
  const trace = traceCounts(), first = await page(), before = await page({ cursor: first.nextCursor });
  for (const mutation of [
    "UPDATE projects SET name='hidden changed' WHERE id=1",
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES(2,'RuntimeNeedle secret','','')",
    "DELETE FROM projects WHERE id=2",
  ]) {
    writer.exec(mutation); const after = await page({ cursor: first.nextCursor }); expect(after).toEqual(before);
  }
  expect(trace.executions()).toBe(1);
  expect(trace.queries.every(sql => !sql.includes("projects"))).toBe(true);
  await fails({ domains: ["project"] }, "FORBIDDEN");
});

it.each([
  ["insert nonmatching row", "INSERT INTO bank_entries(id,kind,question,created_at) VALUES(139,'tech','no-match','')"],
  ["change nonmatching row", "UPDATE bank_entries SET direction='new metadata' WHERE id=138"],
  ["delete nonmatching row", "DELETE FROM bank_entries WHERE id=138"],
  ["same-value UPDATE", "UPDATE bank_entries SET question=question WHERE id=138"],
])("invalidates the selected authorized domain on %s even when the result IDs do not change", async (_label, mutation) => {
  const trace = traceCounts(), first = await page(); writer.exec(mutation);
  await fails({ cursor: first.nextCursor }); expect(trace.executions()).toBe(1); // Reject before rescanning.
  const fresh = await page(); expect(fresh.total).toBe(137); expect(fresh.items).toEqual(first.items);
  expect(fresh.revision).not.toBe(first.revision); expect(trace.executions()).toBe(2);
});

it("rejects a cursor after an out-of-filter application changes, and counts again only for a fresh query", async () => {
  await connect(["search_records_page", "list_applications", "get_application"]);
  const trace = traceCounts(), input = { stages: ["applied"], limit: 1 }, first = await page(input);
  writer.exec("UPDATE applications SET notes='metadata changed outside stage filter' WHERE id=3");
  await fails({ ...input, cursor: first.nextCursor }); expect(trace.executions()).toBe(1);
  const fresh = await page(input); expect(fresh.total).toBe(2); expect(fresh.items).toEqual(first.items); expect(trace.executions()).toBe(2);
});

it("child-table changes invalidate the parent domain even if the parent's own fields already matched", async () => {
  await connect(["search_records_page", "list_notebook", "get_notebook_entry"]);
  const first = await page({ limit: 1 });
  writer.exec("UPDATE notebook_notes SET content='changed child' WHERE notebook_id=1");
  await fails({ cursor: first.nextCursor, limit: 1 });
  expect((await page({ limit: 1 })).items).toEqual(first.items);
});

it("changes to an explicitly unselected domain and rolled-back writes do not invalidate the selected cursor", async () => {
  await connect([...bankPermissions, "list_projects", "get_project"]);
  const args = { domains: ["bank_entry"] }, first = await page(args);
  writer.exec("UPDATE projects SET name='RuntimeNeedle unselected' WHERE id=1");
  writer.exec("BEGIN IMMEDIATE"); writer.exec("UPDATE bank_entries SET question='rolled-back' WHERE id=1"); writer.exec("ROLLBACK");
  const next = await page({ ...args, cursor: first.nextCursor }); expect(next.revision).toBe(first.revision); expect(next.total).toBe(137);
});

it("opens an independent query-only BEGIN snapshot and permits another SQLite connection to commit before reading finishes", async () => {
  const originalPrepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
  const transactions: { connection: DatabaseSync; sql: string }[] = [];
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (/^BEGIN/i.test(sql)) transactions.push({ connection: this, sql });
    return exec.call(this, sql);
  });
  const readers = new Set<DatabaseSync>();
  let queryOnly = 0, committedDuringRead = false;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (!readers.size && sql.startsWith("WITH documents")) {
      readers.add(this); queryOnly = Number(originalPrepare.call(this, "PRAGMA query_only").get()!.query_only);
      writer.prepare("INSERT INTO bank_entries(id,kind,question,created_at) VALUES(139,'tech',?,'')").run(query + " concurrent");
      committedDuringRead = true;
    }
    return originalPrepare.call(this, sql);
  });
  const first = await page();
  // Comparing the native objects through Vitest's matcher can inspect getters on the now-closed reader.
  expect(committedDuringRead).toBe(true); expect(readers.size).toBe(1); expect(readers.has(db)).toBe(false); expect(readers.has(writer)).toBe(false); expect(queryOnly).toBe(1);
  expect(transactions.filter(row => readers.has(row.connection)).map(row => row.sql)).toEqual(["BEGIN"]);
  expect(first.total).toBe(137); expect(first.items[0]!.id).toBe(137);
  expect(writer.prepare("SELECT count(*) n FROM bank_entries WHERE question LIKE ?").get(query + "%")!.n).toBe(138);
  await fails({ cursor: first.nextCursor });
  const fresh = await page(); expect(fresh.total).toBe(138); expect(fresh.items[0]!.id).toBe(139);
});

it("invalidates cursors and old COUNT entries after an actual byte-identical backup restore", async () => {
  const trace = traceCounts(), first = await page(), rows = db.prepare("SELECT * FROM bank_entries ORDER BY id").all();
  const generation = (await import("@/lib/db")).dataGeneration();
  const { createBackupRecordStream } = await import("@/lib/backup-records"), { stageBackupRecordStream } = await import("@/lib/backup-staging"), { restoreAllData } = await import("@/lib/backup");
  const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  try { restoreAllData(staged, true); } finally { staged.dispose(); }
  expect(db.prepare("SELECT * FROM bank_entries ORDER BY id").all()).toEqual(rows);
  expect((await import("@/lib/db")).dataGeneration()).not.toBe(generation);
  await fails({ cursor: first.nextCursor }); expect(trace.executions()).toBe(1);
  const fresh = await page(); expect(fresh.revision).not.toBe(first.revision); expect(fresh.total).toBe(137); expect(trace.executions()).toBe(2);
});

it("rejects previously valid cursors after a workspace identity change or newly authorized domain", async () => {
  const first = await page();
  await connect([...bankPermissions, "list_projects", "get_project"]);
  await fails({ cursor: first.nextCursor });
  const second = await page(); writer.exec("UPDATE mcp_runtime_identity SET instance_id='different-instance' WHERE id=1");
  await fails({ cursor: second.nextCursor });
});
