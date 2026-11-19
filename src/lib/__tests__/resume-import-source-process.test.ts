import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDocumentTableProvenance } from "../document-table-provenance";

// Execute the production modules in distinct OS processes; neither Vitest module
// resets nor a simulated in-memory receipt store can satisfy these assertions.
const workerSource = `
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(r,...args){return resolve.call(this,r.startsWith('@/')?path.resolve('src',r.slice(2)):r,...args)};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const db=require('./src/lib/db.ts').getDb();
const source=require('./src/lib/resume-import-source.ts');
const results=[];
process.stdout.write('SOURCE_READY\\n');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);
process.stdin.on('end',()=>{
  const tasks=JSON.parse(input);
  for(const task of tasks){
    try {
      const value=task.op==='issue'?source.issueResumeImportSource(task.owner,task.text,task.provenance)
        :task.op==='resolve'?source.resolveResumeImportSource(task.owner,task.id,task.text)
        :source.discardResumeImportSource(task.owner,task.id);
      results.push({ok:true,value});
    }catch(error){results.push({ok:false,error:error.name,retryAfter:error.retryAfter});}
  }
  db.close();process.stdout.write('SOURCE_RESULT '+JSON.stringify(results)+'\\n');
});
`;
type Task = { op: "issue" | "resolve" | "discard"; owner: string; text?: string; provenance?: ReturnType<typeof createDocumentTableProvenance>; id?: string };
type Outcome = { ok: boolean; value?: { id: string; markers: unknown[] }; error?: string; retryAfter?: number };
let directory: string;
let database: DatabaseSync;
let auth: typeof import("../auth");
const text = "[表格]\n本人维护模板\n[表格结束]";
const provenance = createDocumentTableProvenance(text, [{ start: 0, end: 4 }]);
const owner = () => createHash("sha256").update(auth.createSession().token).digest("hex");

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-source-process-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
  auth = await import("../auth");
});
afterEach(() => {
  database?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-source-process-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function workers(taskLists: Task[][]): Promise<Outcome[][]> {
  const children = taskLists.map(() => spawn(process.execPath, ["-e", workerSource], {
    cwd: process.cwd(), env: { ...process.env, RESUME_LIFE_DATA_DIR: directory },
  }));
  const states = children.map(child => {
    let output = "", errors = "";
    let markReady!: () => void;
    let failReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
    child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("SOURCE_READY\n")) markReady(); });
    child.stderr.on("data", chunk => { errors += String(chunk); });
    const done = new Promise<Outcome[]>((resolve, reject) => {
      child.on("error", error => { failReady(error); reject(error); });
      child.on("close", code => {
        if (code !== 0) { const error = new Error(`Source worker failed: ${code}: ${errors}`); failReady(error); reject(error); return; }
        const record = output.split("\n").find(line => line.startsWith("SOURCE_RESULT "));
        if (!record) { const error = new Error("Missing source worker result"); failReady(error); reject(error); return; }
        resolve(JSON.parse(record.slice("SOURCE_RESULT ".length)) as Outcome[]);
      });
    });
    // Attach a rejection handler before waiting on the all-workers start barrier.
    void done.catch(() => undefined);
    return { ready, done };
  });
  const timer = setTimeout(() => { for (const child of children) child.kill(); }, 25_000);
  try {
    await Promise.all(states.map(state => state.ready));
    children.forEach((child, index) => child.stdin.end(JSON.stringify(taskLists[index])));
    return await Promise.all(states.map(state => state.done));
  } finally { clearTimeout(timer); for (const child of children) child.kill(); }
}

it("issued receipt survives worker exit and resolves in a fresh process, including same-text known-empty distinction", async () => {
  const session = owner();
  const issued = (await workers([[{ op: "issue", owner: session, text, provenance },
    { op: "issue", owner: session, text, provenance: createDocumentTableProvenance(text, []) }]]))[0]!;
  expect(issued.every(result => result.ok)).toBe(true);
  const resolved = (await workers([issued.map(result => ({ op: "resolve", owner: session, text, id: result.value!.id }))]))[0]!;
  expect(resolved.map(result => result.value)).toEqual([provenance, createDocumentTableProvenance(text, [])]);
});

it("simultaneous processes atomically enforce the shared owner limit", async () => {
  const session = owner();
  const tasks = Array.from({ length: 12 }, () => ({ op: "issue" as const, owner: session, text, provenance }));
  const results = (await workers([tasks, tasks])).flat();
  expect(results.filter(result => result.ok)).toHaveLength(8);
  expect(results.filter(result => !result.ok)).toHaveLength(16);
  expect(results.filter(result => !result.ok).every(result => result.error === "ResumeImportSourceCapacityError" && result.retryAfter! > 0)).toBe(true);
  expect(database.prepare("SELECT count(*) AS n FROM resume_import_source_receipts").get()).toEqual({ n: 8 });
});

it("simultaneous processes atomically enforce the shared global limit across sessions", async () => {
  const sessions = Array.from({ length: 10 }, owner);
  const tasks = (owners: string[]) => owners.flatMap(session => Array.from({ length: 8 }, () => ({ op: "issue" as const, owner: session, text, provenance })));
  const results = (await workers([tasks(sessions.slice(0, 5)), tasks(sessions.slice(5))])).flat();
  expect(results.filter(result => result.ok)).toHaveLength(64);
  expect(results.filter(result => !result.ok)).toHaveLength(16);
  expect(results.filter(result => !result.ok).every(result => result.error === "ResumeImportSourceCapacityError")).toBe(true);
  expect(database.prepare("SELECT count(*) AS n FROM resume_import_source_receipts").get()).toEqual({ n: 64 });
});

it("another process sees discard, logout and generation rotation without a memory cache", async () => {
  const session = owner();
  const issue = async () => (await workers([[{ op: "issue", owner: session, text, provenance }]]))[0]![0]!.value!.id;
  const id = await issue();
  await workers([[{ op: "discard", owner: session, id }]]);
  expect((await workers([[{ op: "resolve", owner: session, id, text }]]))[0]![0]!.error).toBe("ResumeImportSourceGoneError");
  const beforeGeneration = await issue();
  database.exec("INSERT INTO runtime_state VALUES (1,'synthetic-restore')");
  expect((await workers([[{ op: "resolve", owner: session, id: beforeGeneration, text }]]))[0]![0]!.error).toBe("ResumeImportSourceGoneError");
  const beforeLogout = await issue();
  database.prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(session);
  expect((await workers([[{ op: "resolve", owner: session, id: beforeLogout, text }]]))[0]![0]!.error).toBe("ResumeImportSourceGoneError");
}, 30_000);
