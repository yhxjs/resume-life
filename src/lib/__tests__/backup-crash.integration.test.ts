import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
const root = process.cwd();
// Windows CI 的冷启动包含 TypeScript 转译与真实数据库/文件落盘。
const subprocessTimeout = process.platform === "win32" ? 60_000 : 20_000;
// 子进程必须执行真实数据库/文件代码，且硬退出不能被测试运行器的 finally 截获。
const loader = `
const fs = require('node:fs'), path = require('node:path');
const root = ${JSON.stringify(root)};
const ts = require(path.join(root, 'node_modules/typescript'));
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  return resolve.call(this, request.startsWith('@/') ? path.join(root, 'src', request.slice(2)) : request, ...args);
};
require.extensions['.ts'] = function(module, file) {
  module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, file);
};
console.info = console.warn = () => {};
`;

function run(directory: string, source: string) {
  const result = spawnSync(process.execPath, ["-e", loader + source], {
    cwd: root, encoding: "utf8", timeout: subprocessTimeout,
    env: { ...process.env, RESUME_LIFE_DATA_DIR: directory, NODE_ENV: "production" },
  });
  if (result.error) {
    throw new Error(
      `备份恢复子进程执行失败：${result.error.message} (timeout=${subprocessTimeout}ms, status=${result.status}, signal=${result.signal})\n${result.stderr}`,
      { cause: result.error },
    );
  }
  return result;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-crash-test-")) throw new Error("Unsafe cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// 部分阶段需要崩溃、恢复中断、再次启动，共三个子进程。
it.each(["manifest-before", "manifest-after", "quarantine-before", "quarantine-after", "promote-before", "promote-after", "commit-before", "commit-after", "rollback-after-copy", "cleanup-after-manifest"])(
  "恢复在 %s 硬退出后，重启自动恢复数据库与头像一致", (phase) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-crash-test-"));
    directories.push(directory);
    const crashed = run(directory, `
(async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { getDb, initializeDatabase } = require(root + '/src/lib/db.ts');
  const db = getDb();
  const uploads = path.join(process.env.RESUME_LIFE_DATA_DIR, 'uploads');
  fs.mkdirSync(uploads, {recursive:true});
  const content = require(root + '/src/lib/modules.ts').defaultContent('basic');
  function insert(database, id, avatar) {
    database.prepare("INSERT INTO resumes(id,title,created_at,updated_at) VALUES(?,'Synthetic','','')").run(id);
    database.prepare("INSERT INTO resume_modules(resume_id,module_key,type,content,updated_at) VALUES(?,'basic','basic',?,'')")
      .run(id, JSON.stringify({...content,avatar:'/api/uploads/'+avatar}));
  }
  insert(db, 1, 'shared.png'); insert(db, 2, 'old.png');
  fs.writeFileSync(path.join(uploads,'old.png'),'old-photo');
  const source = new DatabaseSync(path.join(process.env.RESUME_LIFE_DATA_DIR,'source.db'));
  initializeDatabase(source); insert(source, 1, 'shared.png'); insert(source, 2, 'new.png');
  fs.writeFileSync(path.join(uploads,'shared.png'),'replacement-photo');
  fs.writeFileSync(path.join(uploads,'new.png'),'new-photo');
  const records = require(root + '/src/lib/backup-records.ts');
  const staging = require(root + '/src/lib/backup-staging.ts');
  const staged = await staging.stageBackupRecordStream(records.createBackupRecordStream(source), db);
  source.close();
  fs.writeFileSync(path.join(uploads,'shared.png'),'original-photo');
  fs.rmSync(path.join(uploads,'new.png'));
  const phase = ${JSON.stringify(phase.startsWith("rollback-") || phase.startsWith("cleanup-") ? "commit-before" : phase)};
  const rename = fs.renameSync;
  fs.renameSync = function(from,to) {
    const kind = path.basename(String(to)) === 'manifest.json' ? 'manifest' : String(to).endsWith('.obsolete') ? 'quarantine' : String(from).endsWith('.incoming') ? 'promote' : '';
    if (phase === kind+'-before') process.exit(86);
    const result = rename.apply(this,arguments);
    if (phase === kind+'-after') process.exit(86);
    return result;
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (this === db && sql === 'COMMIT' && phase === 'commit-before') process.exit(86);
    const result = exec.apply(this,arguments);
    if (this === db && sql === 'COMMIT' && phase === 'commit-after') process.exit(86);
    return result;
  };
  require(root + '/src/lib/backup.ts').restoreAllData(staged,true);
  throw new Error('Crash hook did not run');
})().catch(error=>{console.error(error);process.exit(1)});
`);
    expect(crashed.status, crashed.stderr).toBe(86);
    if (phase === "rollback-after-copy" || phase === "cleanup-after-manifest") {
      const interrupted = run(directory, `
const copy = fs.copyFileSync, remove = fs.rmSync;
fs.copyFileSync = function(from,to) {
  const result = copy.apply(this,arguments);
  if (${JSON.stringify(phase)} === 'rollback-after-copy' && String(from).endsWith('.previous')) process.exit(87);
  return result;
};
fs.rmSync = function(target) {
  const result = remove.apply(this,arguments);
  if (${JSON.stringify(phase)} === 'cleanup-after-manifest' && path.basename(String(target)) === 'manifest.json') process.exit(87);
  return result;
};
require(root + '/src/lib/db.ts').getDb(); throw new Error('Recovery crash hook did not run');
`);
      expect(interrupted.status, interrupted.stderr).toBe(87);
    }
    const restarted = run(directory, `
const db = require(root + '/src/lib/db.ts').getDb();
const uploads = path.join(process.env.RESUME_LIFE_DATA_DIR,'uploads');
const read = name => fs.existsSync(path.join(uploads,name)) ? fs.readFileSync(path.join(uploads,name),'utf8') : null;
console.log(JSON.stringify({
  avatars:db.prepare("SELECT content FROM resume_modules ORDER BY resume_id").all().map(r=>new URL(JSON.parse(r.content).avatar,'http://localhost').pathname),
  shared:read('shared.png'),old:read('old.png'),incoming:read('new.png'),
  pending:fs.readdirSync(uploads).filter(name=>name.startsWith('.restore-')).length,
  snapshots:fs.readdirSync(path.join(process.env.RESUME_LIFE_DATA_DIR,'backups')).filter(name=>!name.endsWith('.uploads')).length
})); db.close();
`);
    expect(restarted.status, restarted.stderr).toBe(0);
    const result = JSON.parse(restarted.stdout);
    const committed = phase === "commit-after";
    expect(result).toEqual({
      avatars: ["/api/uploads/shared.png", committed ? "/api/uploads/new.png" : "/api/uploads/old.png"],
      shared: committed ? "replacement-photo" : "original-photo",
      old: committed ? null : "old-photo",
      incoming: committed ? "new-photo" : null,
      pending: 0, snapshots: 1,
    });
  }, subprocessTimeout * 3 + 10_000,
);

it("合法头像文件名与恢复目录前缀相同不会阻止数据库重启", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-crash-test-"));
  directories.push(directory);
  const name = ".restore-11111111-1111-4111-8111-111111111111";
  const seeded = run(directory, `
const db = require(root + '/src/lib/db.ts').getDb();
fs.mkdirSync(path.join(process.env.RESUME_LIFE_DATA_DIR,'uploads'));
fs.writeFileSync(path.join(process.env.RESUME_LIFE_DATA_DIR,'uploads',${JSON.stringify(name)}),'valid-photo');
db.close();
`);
  expect(seeded.status, seeded.stderr).toBe(0);
  const restarted = run(directory, `
const db = require(root + '/src/lib/db.ts').getDb();
console.log(fs.readFileSync(path.join(process.env.RESUME_LIFE_DATA_DIR,'uploads',${JSON.stringify(name)}),'utf8'));
db.close();
`);
  expect(restarted.status, restarted.stderr).toBe(0);
  expect(restarted.stdout.trim()).toBe("valid-photo");
}, subprocessTimeout * 2 + 10_000);
