import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Console } from "node:console";
import { DatabaseSync } from "node:sqlite";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";

const QUERY = "needle-search-bench";
const round = n => Number(n.toFixed(3));
function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = p => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0);
  return { samples: values.length, minMs: percentile(0), p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1),
    meanMs: round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)) };
}
function assertOwned(config) {
  assert.equal(path.dirname(path.resolve(config.temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(config.temporary).startsWith("resume-life-search-benchmark-"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.temporary, "benchmark-owner.json"), "utf8")).token, config.token);
  const directory = path.join(config.temporary, `case-${config.rows}`);
  if (isMainThread) assert.equal(process.env.RESUME_LIFE_DATA_DIR, directory);
  return path.join(directory, "resume-life.db");
}

// A separate JS thread with its own SQLite connection commits while the search read transaction is deliberately held open.
// Timing of that barrier is reported separately; it is never counted as normal page latency.
function writer(config) {
  const databasePath = assertOwned(config), control = new Int32Array(config.shared);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout=1000"); db.exec("PRAGMA foreign_keys=ON");
    const journal = db.prepare("PRAGMA journal_mode").get().journal_mode;
    assert.equal(journal, "wal");
    const update = db.prepare("UPDATE bank_entries SET direction=? WHERE id=1");
    const baseline = [], concurrent = [];
    for (let i = 0; i < config.writes; i++) { const t = performance.now(); update.run(`baseline-${i}`); baseline.push(performance.now() - t); }
    parentPort.postMessage({ kind: "ready" });
    const waited = Atomics.wait(control, 0, 0, 30_000); assert.notEqual(waited, "timed-out");
    assert.equal(Atomics.load(control, 0), 1); assert.equal(Atomics.load(control, 1), 1);
    const insertStart = performance.now();
    db.prepare("INSERT INTO bank_entries(id,kind,question,created_at) VALUES(?,'tech',?,'2026-11-26T00:00:00.000Z')").run(config.rows + 1, `newly committed ${QUERY}`);
    const insertMs = performance.now() - insertStart;
    let commitsWhileSnapshotOpen = Atomics.load(control, 1) === 1 ? 1 : 0;
    for (let i = 0; i < config.writes; i++) {
      const t = performance.now(); update.run(`concurrent-${i}`); concurrent.push(performance.now() - t);
      if (Atomics.load(control, 1) === 1) commitsWhileSnapshotOpen++;
    }
    parentPort.postMessage({ kind: "complete", ok: true, baselineUpdateLatency: distribution(baseline), concurrentUpdateLatency: distribution(concurrent), insertMs: round(insertMs),
      commitsWhileSnapshotOpen, totalCommitted: config.writes + 1, journalMode: journal, synchronous: db.prepare("PRAGMA synchronous").get().synchronous });
    Atomics.store(control, 0, 2); Atomics.notify(control, 0);
  } catch (error) {
    parentPort.postMessage({ kind: "complete", ok: false, error: error instanceof Error ? error.message : String(error) });
    Atomics.store(control, 0, 3); Atomics.notify(control, 0);
  } finally { db.close(); }
}

async function benchmark(config) {
  assertOwned(config);
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  const options = { tsconfig: path.join(config.root, "tsconfig.json") };
  (await import("tsx/esm/api")).register(options); (await import("tsx/cjs/api")).register(options);
  const { getDb, CURRENT_DB_VERSION } = await import(pathToFileURL(path.join(config.root, "src/lib/db.ts")).href);
  const { searchRecordsPage } = await import(pathToFileURL(path.join(config.root, "src/lib/mcp-search.ts")).href);
  const db = getDb();
  const databasePath = assertOwned(config);
  assert.equal(db.prepare("SELECT count(*) n FROM bank_entries").get().n, 0, "Never benchmark existing user records");
  const insert = db.prepare("INSERT INTO bank_entries(id,kind,question,direction,created_at) VALUES(?,'tech',?,'bench','2026-11-26T00:00:00.000Z')");
  const seedStart = performance.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let id = 1; id <= config.rows; id++) {
      const suffix = ` ${QUERY} ${id % 97 === 0 ? "selective-97-marker" : "ordinary"}`;
      const prefix = `Synthetic question ${String(id).padStart(8, "0")} `;
      const question = prefix + "context 文本 ".repeat(Math.ceil(config.bodyChars / 11)).slice(0, Math.max(0, config.bodyChars - prefix.length - suffix.length)) + suffix;
      insert.run(id, question);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  db.exec("ANALYZE"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const seedMs = performance.now() - seedStart;
  const allowed = new Set(["list_bank_entries", "read_record_section"]);
  const input = { query: QUERY, domains: ["bank_entry"], limit: config.limit };
  const counters = { countExecutions: 0, pageQueries: 0, readBegins: 0, immediateBegins: 0, queryOnlyBegins: 0 };
  const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec;
  let probe = null, writerThread;
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql.startsWith("WITH documents")) {
      probe?.(this);
      if (/SELECT COUNT\(\*\) AS count/.test(sql)) {
        const statement = originalPrepare.call(this, sql), originalGet = statement.get;
        statement.get = function (...args) { counters.countExecutions++; return originalGet.apply(this, args); };
        return statement;
      }
      counters.pageQueries++;
    }
    return originalPrepare.call(this, sql);
  };
  DatabaseSync.prototype.exec = function (sql) {
    const result = originalExec.call(this, sql);
    if (/^BEGIN(?:\s|$)/i.test(sql)) {
      if (/IMMEDIATE/i.test(sql)) counters.immediateBegins++; else counters.readBegins++;
      if (originalPrepare.call(this, "PRAGMA query_only").get().query_only === 1) counters.queryOnlyBegins++;
    }
    return result;
  };
  const read = args => { const start = performance.now(); const result = searchRecordsPage(args, name => allowed.has(name)); return { result, ms: performance.now() - start }; };
  try {
    const first = read(input);
    assert.equal(first.result.total, config.rows);
    const firstCounters = { ...counters };
    const warmFirst = [], continuation = [];
    for (let i = 0; i < config.samples; i++) {
      warmFirst.push(read(input).ms);
      if (first.result.nextCursor) continuation.push(read({ ...input, cursor: first.result.nextCursor }).ms);
    }
    const fullStart = performance.now(), fullCountBefore = counters.countExecutions;
    const seen = new Uint8Array(config.rows + 1), actualHash = createHash("sha256"), expectedHash = createHash("sha256");
    let cursor, received = 0, duplicates = 0, outOfOrder = 0, pageCount = 0, maxResponseUtf16 = 0;
    const pageTimes = [];
    do {
      const { result, ms } = read({ ...input, ...(cursor ? { cursor } : {}) });
      pageTimes.push(ms); pageCount++; assert.equal(result.total, config.rows);
      maxResponseUtf16 = Math.max(maxResponseUtf16, JSON.stringify(result).length);
      assert.ok(result.items.length > 0); assert.ok(pageCount <= config.rows);
      for (const row of result.items) {
        assert.equal(row.domain, "bank_entry"); assert.ok(row.id >= 1 && row.id <= config.rows);
        if (seen[row.id]) duplicates++; seen[row.id] = 1;
        if (row.id !== config.rows - received) outOfOrder++;
        actualHash.update(`bank_entry:${row.id}\n`); received++;
      }
      cursor = result.nextCursor;
      if (pageCount % 500 === 0) process.stderr.write(`[search-benchmark] ${config.rows}: ${received} records / ${pageCount} pages verified\n`);
    } while (cursor);
    const traversalMs = performance.now() - fullStart;
    const missing = config.rows - seen.reduce((a, b) => a + b, 0);
    for (let id = config.rows; id > 0; id--) expectedHash.update(`bank_entry:${id}\n`);
    const actualIdsSha256 = actualHash.digest("hex"), expectedIdsSha256 = expectedHash.digest("hex");
    assert.equal(received, config.rows); assert.equal(duplicates, 0); assert.equal(missing, 0); assert.equal(outOfOrder, 0);
    assert.equal(actualIdsSha256, expectedIdsSha256);
    const traversalCounts = counters.countExecutions - fullCountBefore;
    const selective = read({ ...input, query: "selective-97-marker" });
    assert.equal(selective.result.total, Math.floor(config.rows / 97));

    const shared = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT), control = new Int32Array(shared);
    writerThread = new Worker(new URL(import.meta.url), { workerData: { ...config, shared } });
    let resolveReady, rejectReady, resolveComplete, rejectComplete;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const complete = new Promise((resolve, reject) => { resolveComplete = resolve; rejectComplete = reject; });
    // Attach a rejection handler before the reader blocks, avoiding a transient unhandled rejection.
    complete.catch(() => {});
    writerThread.on("message", message => {
      if (message.kind === "ready") resolveReady();
      if (message.kind === "complete") { if (!message.ok) rejectReady(new Error(message.error)); resolveComplete(message); }
    });
    writerThread.on("error", error => { rejectReady(error); rejectComplete(error); });
    writerThread.on("exit", code => { if (code !== 0) { rejectReady(new Error(`writer exited ${code}`)); rejectComplete(new Error(`writer exited ${code}`)); } });
    await ready;
    let overlap = null;
    probe = reader => {
      probe = null;
      assert.notEqual(reader, db, "Search must use its own read connection");
      const queryOnly = originalPrepare.call(reader, "PRAGMA query_only").get().query_only;
      const holdStart = performance.now();
      Atomics.store(control, 1, 1); Atomics.store(control, 0, 1); Atomics.notify(control, 0);
      while (Atomics.load(control, 0) === 1) {
        const waited = Atomics.wait(control, 0, 1, 10_000); assert.notEqual(waited, "timed-out", "writer did not commit while snapshot was open");
      }
      assert.equal(Atomics.load(control, 0), 2, "writer failed, potentially blocked by a write transaction");
      overlap = { queryOnly: queryOnly === 1, separateReadConnection: true, heldSnapshotMs: round(performance.now() - holdStart) };
    };
    const snapshot = read({ ...input, limit: 1 }); Atomics.store(control, 1, 0);
    assert.ok(overlap); assert.equal(overlap.queryOnly, true);
    const concurrentWriter = await complete;
    assert.equal(concurrentWriter.ok, true); assert.equal(concurrentWriter.commitsWhileSnapshotOpen, config.writes + 1);
    assert.equal(snapshot.result.total, config.rows); assert.equal(snapshot.result.items[0].id, config.rows);
    const afterRows = db.prepare("SELECT COUNT(*) n FROM bank_entries").get().n;
    assert.equal(afterRows, config.rows + 1);
    const conflictStart = performance.now();
    let conflictCode;
    try { searchRecordsPage({ ...input, cursor: snapshot.result.nextCursor }, name => allowed.has(name)); }
    catch (error) { conflictCode = error.code; }
    assert.equal(conflictCode, "CONFLICT");
    const conflictMs = performance.now() - conflictStart;
    const after = read(input); assert.equal(after.result.total, config.rows + 1); assert.equal(after.result.items[0].id, config.rows + 1);
    assert.equal(counters.immediateBegins, 0, "Search opened BEGIN IMMEDIATE");
    assert.equal(counters.readBegins, counters.queryOnlyBegins);
    return { ok: true, rows: config.rows, seedMs: round(seedMs), dbVersion: CURRENT_DB_VERSION, databaseBytesBeforeWriter: fs.statSync(databasePath).size,
      distribution: { domain: "bank_entry", matchRate: 1, query: QUERY, questionUtf16Length: config.bodyChars, limit: config.limit, deterministic: true },
      latency: { firstPageMs: round(first.ms), firstPageCountExecutions: firstCounters.countExecutions, warmFirstPage: distribution(warmFirst), continuationPage: distribution(continuation), allPages: distribution(pageTimes),
        selectiveFirstPage: { query: "selective-97-marker", matches: selective.result.total, ms: round(selective.ms) } },
      traversal: { pages: pageCount, received, missing, duplicates, outOfOrder, fullTraversal: true, totalMs: round(traversalMs), actualIdsSha256, expectedIdsSha256,
        additionalCountExecutions: traversalCounts, maxResponseUtf16 },
      concurrentWriter: { ...concurrentWriter, kind: undefined, ...overlap, observedSnapshotTotal: snapshot.result.total, observedSnapshotMaxId: snapshot.result.items[0].id, rowsAfterWrites: afterRows,
        conflictAfterMutation: { code: conflictCode, ms: round(conflictMs) }, freshPageTotal: after.result.total },
      sqlEvidence: { ...counters, queryOnlyChecks: true, instrumentation: "Count executions and BEGIN statements observed on actual DatabaseSync instances; prototype hooks do not rewrite SQL." } };
  } finally {
    probe = null; if (writerThread) await writerThread.terminate();
    DatabaseSync.prototype.prepare = originalPrepare; DatabaseSync.prototype.exec = originalExec;
    db.close();
  }
}

if (!isMainThread) writer(workerData);
else {
  try { process.stdout.write(JSON.stringify(await benchmark(JSON.parse(process.argv[2]))) + "\n"); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
