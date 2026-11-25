import assert from "node:assert/strict";
import { Console } from "node:console";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only the isolated Codex check may invoke this fixture. It exercises the production
// streaming backup and restore path against synthetic data, with no Web server.
const temporary = path.resolve(process.argv[2] ?? "");
const applicationId = Number(process.argv[3]);
if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("resume-life-codex-check-") ||
    path.resolve(process.env.RESUME_LIFE_DATA_DIR ?? "") !== path.join(temporary, "data") ||
    !Number.isSafeInteger(applicationId) || applicationId <= 0) throw new Error("Unsafe Codex backup fixture target");
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const options = { tsconfig: path.join(root, "tsconfig.json") };
(await import("tsx/esm/api")).register(options);
(await import("tsx/cjs/api")).register(options);
const { getDb, dataGeneration, CURRENT_DB_VERSION } = await import(new URL("../src/lib/db.ts", import.meta.url).href);
const { createBackupRecordStream } = await import(new URL("../src/lib/backup-records.ts", import.meta.url).href);
const { stageBackupRecordStream } = await import(new URL("../src/lib/backup-staging.ts", import.meta.url).href);
const { restoreAllData } = await import(new URL("../src/lib/backup.ts", import.meta.url).href);
const { getApplicationById, updateApplication } = await import(new URL("../src/lib/applications.ts", import.meta.url).href);
const db = getDb();
let staged;
try {
  const generation = dataGeneration(db);
  const before = getApplicationById(applicationId);
  assert.ok(before);
  staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  assert.equal(staged.manifest.dbVersion, CURRENT_DB_VERSION);
  assert.ok(staged.manifest.tables.every(table => !table.startsWith("mcp_")));
  updateApplication(applicationId, { notes: "临时修改：恢复后应回到备份内容。" });
  assert.notEqual(getApplicationById(applicationId).notes, before.notes);
  assert.equal(restoreAllData(staged, true).success, true);
  assert.equal(getApplicationById(applicationId).notes, before.notes);
  assert.notEqual(dataGeneration(db), generation);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mcp_drafts").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mcp_generation_requests WHERE response_json IS NOT NULL").get().n, 0);
  process.stdout.write(JSON.stringify({ restored: true, databaseVersion: CURRENT_DB_VERSION, runtimeTablesExcluded: true }) + "\n");
} finally {
  staged?.dispose();
  db.close();
}
