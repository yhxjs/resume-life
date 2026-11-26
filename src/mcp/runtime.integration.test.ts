import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DatabaseSync } from "node:sqlite";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Bag = Record<string, unknown>;
type Job = { jobId: string; status: string; resultAvailable: boolean };
let directory: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer;
const allowed = () => true;
async function ok<T = Bag>(name: string, args: Bag = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return (result.structuredContent as { data: T }).data;
}
async function fails(name: string, args: Bag, code: string) {
  expect((await client.callTool({ name, arguments: args })).structuredContent).toMatchObject({ ok: false, error: { code } });
}
async function connect(allowlist: Set<string> | null = null, writeEnabled = true) {
  await client?.close(); await server?.close();
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist, writeEnabled, llmEnabled: false, timeoutMs: 10_000 });
  client = new Client({ name: "runtime-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-runtime-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory); db = (await import("@/lib/db")).getDb();
  db.exec(`INSERT INTO resumes(id,title,created_at,updated_at) VALUES(1,'固定履历','','');
    INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES
    (1,'summary','summary','自我评价',1,'{"text":"参与数据工具开发。"}',''),
    (1,'basic','basic','基本信息',0,'{"name":"王小明","phone":"13800138000","email":"xiaoming@example.com","location":"香港","birthday":"","links":""}','');`);
  const { normalizeContent, isModuleKey } = await import("@/lib/modules");
  for (const row of db.prepare("SELECT id,type,content FROM resume_modules").all() as { id: number; type: string; content: string }[]) {
    if (isModuleKey(row.type)) db.prepare("UPDATE resume_modules SET content=? WHERE id=?").run(JSON.stringify(normalizeContent(row.type, JSON.parse(row.content))), row.id);
  }
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close();
  // Let detached finalizers release their intervals before closing the fixture connection.
  await new Promise<void>(resolve => setImmediate(resolve));
  db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-runtime-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
async function exportInput(key = "runtime-export-once") {
  const source = { resumeId: 1 };
  const context = await ok<{ revision: string }>("get_resume_export_context", { source });
  return { source, expectedRevision: context.revision, format: "markdown", idempotencyKey: key };
}
async function finished(id: string) {
  let job: Job | undefined;
  await vi.waitFor(async () => { job = await ok<Job>("get_mcp_job", { jobId: id }); expect(job.status).not.toBe("running"); }, { timeout: 5000, interval: 10 });
  return job!;
}

it("reconnects to one persisted export and reads its exact result without relaunching it", async () => {
  const input = await exportInput();
  const first = await ok<Job>("start_mcp_job", { operation: "export_resume", arguments: input });
  await connect(); expect((await finished(first.jobId)).status).toBe("succeeded");
  const second = await ok<Job>("start_mcp_job", { operation: "export_resume", arguments: input });
  expect(second.jobId).toBe(first.jobId);
  const page = await ok<{ text: string }>("get_mcp_job_result", { jobId: first.jobId });
  const artifact = JSON.parse(page.text);
  expect(await ok("export_resume", input)).toEqual(artifact);
  expect(await ok("read_export_artifact", { artifactId: artifact.artifactId })).toMatchObject({ sha256: artifact.sha256 });
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_jobs").get()).toEqual({ n: 1 });
  expect(await ok("get_mcp_job", { jobId: first.jobId })).toMatchObject({ progress: { phase: "succeeded", unit: "bytes", completed: artifact.byteLength, total: artifact.byteLength }, elapsedMs: expect.any(Number), lastHeartbeatAt: expect.any(String) });
  await fails("start_mcp_job", { operation: "export_resume", arguments: { ...input, format: "docx" } }, "CONFLICT");
});

it.each([false, true])("reports resource waiting, resumes on release, or cancels without entering the worker (%s)", async cancel => {
  const { startMcpJob, cancelMcpJob, getMcpJob } = await import("@/lib/mcp-jobs");
  const { withMcpWorkLease } = await import("@/lib/mcp-work-leases");
  const { reportMcpProgress } = await import("@/lib/mcp-progress");
  for (const token of ["busy-one", "busy-two"]) db.prepare("INSERT INTO mcp_work_leases VALUES(?,'render','initial',?,'2099-01-01')").run(token, process.pid);
  let ran = false;
  const job = startMcpJob({ operation: "export_resume", payload: { idempotencyKey: "waiting-progress-job" }, requiredTools: ["get_resume"], timeoutMs: 5000 }, signal => withMcpWorkLease("render", signal, async () => {
    ran = true; reportMcpProgress("rendering", 1, 1, "files"); return { id: 1 };
  }));
  await vi.waitFor(() => expect(getMcpJob(job.jobId, allowed).progress).toMatchObject({ phase: "waiting_resource", completed: 0, total: null }));
  const waiting = getMcpJob(job.jobId, allowed);
  expect(waiting.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(waiting.progress?.updatedAt).toEqual(expect.any(String));
  expect(await ok("get_mcp_status")).toMatchObject({ jobs: { running: 1, waiting: 1 }, leases: [{ resource: "render", active: 2 }, { resource: "capture", active: 0 }, { resource: "parse", active: 0 }] });
  await connect(new Set(["get_mcp_status"]));
  expect(await ok("get_mcp_status")).toMatchObject({ jobs: { running: 0, waiting: 0 } });
  if (cancel) cancelMcpJob(job.jobId, allowed);
  else db.exec("DELETE FROM mcp_work_leases");
  await vi.waitFor(() => expect(getMcpJob(job.jobId, allowed).status).toBe(cancel ? "cancelled" : "succeeded"));
  expect(ran).toBe(!cancel);
  if (!cancel) expect(getMcpJob(job.jobId, allowed).progress).toMatchObject({ phase: "succeeded", completed: 1, total: 1, unit: "files" });
});

it("checks the original synchronous receipt before recovering a new asynchronous job", async () => {
  const input = await exportInput(); await ok("export_resume", input);
  await fails("start_mcp_job", { operation: "export_resume", arguments: { ...input, format: "docx" } }, "CONFLICT");
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_jobs").get()).toEqual({ n: 0 });
  expect(await ok("start_mcp_job", { operation: "export_resume", arguments: input })).toMatchObject({ status: "succeeded", resultAvailable: true });
});

it("enforces operation and source permissions on submission, lookup, result and cancellation", async () => {
  const input = await exportInput();
  const job = await ok<Job>("start_mcp_job", { operation: "export_resume", arguments: input }); await finished(job.jobId);
  await connect(new Set(["start_mcp_job", "get_mcp_job", "list_mcp_jobs", "get_mcp_job_result", "cancel_mcp_job"]));
  await fails("start_mcp_job", { operation: "export_resume", arguments: input }, "FORBIDDEN");
  await fails("get_mcp_job", { jobId: job.jobId }, "FORBIDDEN");
  await fails("get_mcp_job_result", { jobId: job.jobId }, "FORBIDDEN");
  expect(await ok("list_mcp_jobs")).toMatchObject({ items: [] });
  await connect(new Set(["get_mcp_job", "get_mcp_job_result", "cancel_mcp_job", "get_resume", "get_resume_export_context"]));
  expect(await ok("get_mcp_job", { jobId: job.jobId })).toMatchObject({ status: "succeeded" });
  await fails("cancel_mcp_job", { jobId: job.jobId }, "FORBIDDEN");
});

it("cancels before commit even when the worker ignores the abort signal", async () => {
  const { startMcpJob, cancelMcpJob, getMcpJob } = await import("@/lib/mcp-jobs");
  const { inTransaction } = await import("@/lib/db");
  let resume!: () => void, entered!: () => void, done!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const completed = new Promise<void>(resolve => { done = resolve; });
  const job = startMcpJob({ operation: "export_resume", payload: { idempotencyKey: "cancel-running-test" }, requiredTools: [], timeoutMs: 5000 }, async () => {
    entered(); await gate;
    try { return inTransaction(() => { db.exec("UPDATE resumes SET title='不应保存' WHERE id=1"); return { id: 1 }; }); }
    finally { done(); }
  });
  await started; expect(cancelMcpJob(job.jobId, allowed).status).toBe("cancelled"); resume(); await completed;
  expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历" });
  expect(getMcpJob(job.jobId, allowed).status).toBe("cancelled");
});

it("records timeout without committing late changes", async () => {
  const { startMcpJob, getMcpJob } = await import("@/lib/mcp-jobs");
  const { inTransaction } = await import("@/lib/db");
  const job = startMcpJob({ operation: "export_resume", payload: { idempotencyKey: "timeout-running-test" }, requiredTools: [], timeoutMs: 100 }, async signal => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return inTransaction(() => { db.exec("UPDATE resumes SET title='超时写入' WHERE id=1"); return { id: 1 }; });
  });
  await vi.waitFor(() => expect(getMcpJob(job.jobId, allowed)).toMatchObject({ status: "failed", errorCode: "TIMEOUT" }));
  expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历" });
});

it("reports TIMEOUT when polling wins the race with the worker timer", async () => {
  const { startMcpJob, getMcpJob } = await import("@/lib/mcp-jobs");
  const run = vi.fn(async () => ({ id: 1 }));
  const job = startMcpJob({ operation: "export_resume", payload: { idempotencyKey: "poll-before-timeout" }, requiredTools: [], timeoutMs: 5000 }, run);
  db.prepare("UPDATE mcp_jobs SET deadline_at='2000-01-01' WHERE job_id=?").run(job.jobId);
  expect((await import("@/lib/mcp-status")).getMcpStatus().jobs).toMatchObject({ failed: 1, interrupted: 0 });
  expect(getMcpJob(job.jobId, allowed)).toMatchObject({ status: "failed", errorCode: "TIMEOUT" });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(run).not.toHaveBeenCalled();
});

it("recovers committed work after owner loss and identifies interrupted work without restarting", async () => {
  const input = await exportInput();
  const job = await ok<Job>("start_mcp_job", { operation: "export_resume", arguments: input }); await finished(job.jobId);
  db.prepare("UPDATE mcp_jobs SET status='running',result_json=NULL,payload_json=?,owner_pid=-1 WHERE job_id=?").run(JSON.stringify(input), job.jobId);
  expect(await ok("get_mcp_job", { jobId: job.jobId })).toMatchObject({ status: "succeeded", resultAvailable: true });
  db.prepare("UPDATE mcp_jobs SET status='running',result_json=NULL,payload_json=?,request_key='uncommitted-key',owner_pid=-1 WHERE job_id=?").run(JSON.stringify(input), job.jobId);
  expect(await ok("get_mcp_job", { jobId: job.jobId })).toMatchObject({ status: "interrupted", resultAvailable: false });
});

it("retains successful state when a crashed worker's committed artifact has expired", async () => {
  const input = await exportInput();
  const job = await ok<Job>("start_mcp_job", { operation: "export_resume", arguments: input }); await finished(job.jobId);
  db.exec("UPDATE mcp_creation_receipts SET created_at='2000-01-01T00:00:00.000Z'");
  db.prepare("UPDATE mcp_jobs SET status='running',result_json=NULL,payload_json=?,owner_pid=-1 WHERE job_id=?").run(JSON.stringify(input), job.jobId);
  expect(await ok("get_mcp_job", { jobId: job.jobId })).toMatchObject({ status: "succeeded", resultAvailable: false });
  await fails("get_mcp_job_result", { jobId: job.jobId }, "NOT_FOUND");
});

it("shares work slots with another process and reaps abandoned leases", async () => {
  const { withMcpWorkLease } = await import("@/lib/mcp-work-leases");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const running = withMcpWorkLease("render", new AbortController().signal, async () => {
    return withMcpWorkLease("render", new AbortController().signal, async () => { entered(); await gate; });
  });
  await ready;
  const code = `const { withMcpWorkLease } = require('./src/lib/mcp-work-leases.ts'); withMcpWorkLease('render',new AbortController().signal,async()=>{}).then(()=>{console.log('unexpected')},e=>{console.log(e.code)});`;
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", code], { cwd: process.cwd(), env: { ...process.env, RESUME_LIFE_DATA_DIR: directory }, timeout: 15_000 });
    expect(result.stdout.trim().split(/\r?\n/).at(-1)).toBe("BUSY");
  } finally { release(); await running; }
  db.exec("INSERT INTO mcp_work_leases VALUES('abandoned','render','initial',-1,'2099-01-01'); INSERT INTO mcp_work_leases VALUES('expired','render','initial',1,'2000-01-01')");
  await expect(withMcpWorkLease("render", new AbortController().signal, async () => "ok")).resolves.toBe("ok");
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_work_leases").get()).toEqual({ n: 0 });
});

it("rejects a commit after its cross-process lease is revoked", async () => {
  const { withMcpWorkLease, mcpCleanupScope } = await import("@/lib/mcp-work-leases");
  const { inTransaction } = await import("@/lib/db");
  await expect(withMcpWorkLease("parse", new AbortController().signal, async () => {
    mcpCleanupScope(() => db.exec("DELETE FROM mcp_work_leases"));
    return inTransaction(() => { db.exec("UPDATE resumes SET title='失效租约' WHERE id=1"); });
  })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历" });
});

it.each(["cancel", "exit"] as const)("observes %s of an actual worker process without committing late writes", async mode => {
  const code = `
    const { startMcpJob } = require('./src/lib/mcp-jobs.ts');
    const { getDb,inTransaction } = require('./src/lib/db.ts');
    const { once } = require('node:events');
    const job = startMcpJob({operation:'export_resume',payload:{idempotencyKey:'cross-process-worker'},requiredTools:['get_resume','get_resume_export_context'],timeoutMs:60000},async()=>{
      console.log(JSON.stringify({ready:true,jobId:job.jobId}));
      process.stdin.resume(); await once(process.stdin,'data');
      try { return inTransaction(()=>{getDb().exec("UPDATE resumes SET title='late worker' WHERE id=1");return {id:1};}); }
      finally { setImmediate(()=>process.exit(0)); }
    });`;
  const worker = spawn(process.execPath, ["--import", "tsx", "--eval", code], { cwd: process.cwd(), env: { ...process.env, RESUME_LIFE_DATA_DIR: directory }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(worker, "exit");
  let output = "", errors = "";
  worker.stdout.on("data", value => { output += value.toString(); }); worker.stderr.on("data", value => { errors += value.toString(); });
  try {
    await vi.waitFor(() => expect(output, errors).toContain('"ready":true'), { timeout: 10_000, interval: 20 });
    const line = output.split(/\r?\n/).find(line => line.startsWith('{"ready":'))!;
    const { jobId } = JSON.parse(line);
    if (mode === "cancel") {
      expect(await ok("cancel_mcp_job", { jobId })).toMatchObject({ status: "cancelled" }); worker.stdin.end("continue");
    } else worker.kill();
    await exited;
    expect(await ok("get_mcp_job", { jobId })).toMatchObject({ status: mode === "cancel" ? "cancelled" : "interrupted" });
    expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历" });
  } finally { if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await exited; } }
}, 20_000);

it("cleans expired artifacts, results and old orphan files while preserving business records and tombstones", async () => {
  const input = await exportInput(); const artifact = await ok<{ artifactId: string }>("export_resume", input);
  const { mcpCreateWithResult, readMcpOperationResult } = await import("@/lib/mcp-state");
  mcpCreateWithResult("fixture-batch", "cached-result-key", {}, () => ({ id: 1, details: "cached only" }), () => true);
  db.exec("UPDATE mcp_creation_receipts SET created_at='2000-01-01T00:00:00.000Z'");
  const root = path.join(directory, "mcp-artifacts"), orphan = path.join(root, `${"a".repeat(64)}.bin`), young = path.join(root, `${"b".repeat(64)}.bin`);
  fs.writeFileSync(orphan, "orphan"); fs.utimesSync(orphan, new Date(0), new Date(0)); fs.writeFileSync(young, "active-write");
  const preview = await ok<{ candidates: { kind: string }[]; previewToken: string }>("preview_mcp_cache_cleanup");
  expect(preview.candidates.map(candidate => candidate.kind)).toEqual(["artifact", "orphan", "result"]);
  const result = await ok("cleanup_mcp_cache", { previewToken: preview.previewToken }); expect(result).toMatchObject({ removedEntries: 3 });
  expect(fs.existsSync(orphan)).toBe(false); expect(fs.existsSync(young)).toBe(true);
  expect(fs.existsSync(path.join(root, `${artifact.artifactId}.bin`))).toBe(false);
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历" });
  expect(() => readMcpOperationResult("fixture-batch", "cached-result-key")).toThrow();
  await fails("export_resume", input, "CONFLICT");
  await fails("cleanup_mcp_cache", { previewToken: preview.previewToken }, "CONFLICT");
});

it("does not delete a file replaced after preview or caches belonging to an active job", async () => {
  const input = await exportInput(); const artifact = await ok<{ artifactId: string }>("export_resume", input);
  db.exec("UPDATE mcp_creation_receipts SET created_at='2000-01-01T00:00:00.000Z'");
  const preview = await ok<{ previewToken: string }>("preview_mcp_cache_cleanup");
  const file = path.join(directory, "mcp-artifacts", `${artifact.artifactId}.bin`); fs.appendFileSync(file, "changed");
  await fails("cleanup_mcp_cache", { previewToken: preview.previewToken }, "CONFLICT"); expect(fs.existsSync(file)).toBe(true);
  db.prepare(`INSERT INTO mcp_jobs(job_id,operation,request_key,input_hash,generation,payload_json,required_tools,status,owner_token,owner_pid,lease_expires_at,deadline_at,created_at,updated_at)
    VALUES('active','export_resume',?,'hash','initial','{}','[]','running','owner',?,'2099-01-01','2099-01-01','','')`).run(input.idempotencyKey, process.pid);
  expect(await ok("preview_mcp_cache_cleanup")).toMatchObject({ candidates: [] });
});

it("allows cleanup at the entry limit and enforces capacity before committing cached mutations", async () => {
  const { previewMcpCache, maintainMcpCache, assertMcpCacheCapacity } = await import("@/lib/mcp-cache");
  const { mcpCreateWithResult } = await import("@/lib/mcp-state");
  db.exec("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO mcp_creation_receipts SELECT 'fixture',CAST(x AS TEXT),'hash','initial',1,'2000-01-01' FROM n; INSERT INTO mcp_operation_results SELECT tool,request_key,'{}' FROM mcp_creation_receipts");
  expect(() => assertMcpCacheCapacity(1)).toThrow(/条目/);
  const preview = previewMcpCache(1000); expect(preview.candidates).toHaveLength(1000);
  expect(maintainMcpCache(1000, preview.previewToken).removedEntries).toBe(1000);
  vi.stubEnv("RESUME_LIFE_MCP_CACHE_MAX_BYTES", String(1024 * 1024));
  expect(() => mcpCreateWithResult("fixture", "capacity-rollback", {}, () => {
    db.exec("UPDATE resumes SET title='应回滚' WHERE id=1"); return { id: 1, large: "x".repeat(1024 * 1024) };
  }, () => true)).toThrow(/容量/);
  expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历" });
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE request_key='capacity-rollback'").get()).toBeUndefined();
});

it("requires preview permission for explicit cleanup and invalidates job results on restore", async () => {
  const job = await ok<Job>("start_mcp_job", { operation: "export_resume", arguments: await exportInput() }); await finished(job.jobId);
  const { createBackupRecordStream } = await import("@/lib/backup-records");
  const { stageBackupRecordStream } = await import("@/lib/backup-staging");
  const { restoreAllData } = await import("@/lib/backup");
  const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  try { restoreAllData(staged, true); } finally { staged.dispose(); }
  expect(await ok("get_mcp_job", { jobId: job.jobId })).toMatchObject({ status: "invalidated", resultAvailable: false });
  await fails("get_mcp_job_result", { jobId: job.jobId }, "CONFLICT");
  expect(db.prepare("SELECT payload_json,result_json FROM mcp_jobs").get()).toEqual({ payload_json: null, result_json: null });
  await connect(new Set(["cleanup_mcp_cache"])); await fails("cleanup_mcp_cache", { previewToken: "a".repeat(64) }, "FORBIDDEN");
});
