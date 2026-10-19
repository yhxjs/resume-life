import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.each([false, true])("初始化在短锁时等待、超期有界失败（超期=%s）", async (holdPastTimeout) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-init-lock-"));
  const db = new DatabaseSync(path.join(directory, "resume-life.db"));
  // 释放写锁也可能与子进程的短暂读锁重叠；夹具不能按零等待立即失败。
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("BEGIN IMMEDIATE");
  const source = `
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(r,...args){return resolve.call(this,r.startsWith('@/')?path.resolve('src',r.slice(2)):r,...args)};
Module._extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {getDb}=require('./src/lib/db.ts');
console.log('ready');
const start=Date.now();
try {const db=getDb();console.log(JSON.stringify({ok:true,elapsed:Date.now()-start}));db.close()}
catch(e){console.log(JSON.stringify({ok:false,elapsed:Date.now()-start,message:e.message}))}
`;
  const child = spawn(process.execPath, ["-e", source], { cwd: process.cwd(), env: { ...process.env, RESUME_LIFE_DATA_DIR: directory } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releaseError: unknown;
  try {
    let output = "";
    let scheduled = false;
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (!holdPastTimeout && !scheduled && output.includes("ready")) {
        scheduled = true;
        timer = setTimeout(() => {
          try { db.exec("COMMIT"); }
          catch (error) { releaseError = error; child.kill(); }
        }, 200);
      }
    });
    // 消费 stderr 避免子进程日志阻塞。
    child.stderr.resume();
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", () => resolve()); });
    if (releaseError) throw releaseError;
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(result.ok).toBe(!holdPastTimeout);
    if (holdPastTimeout) {
      expect(result.message).toContain("locked");
      expect(result.elapsed).toBeGreaterThanOrEqual(4500);
      expect(result.elapsed).toBeLessThan(8000);
    }
  } finally {
    if (timer) clearTimeout(timer);
    child.kill();
    db.close();
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-init-lock-")) throw new Error("Unsafe cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
