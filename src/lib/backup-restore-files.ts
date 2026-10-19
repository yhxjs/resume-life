import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ValidatedBackupHandle } from "./backup";
import { logCleanupFailure, logServerEvent } from "./server-errors";
import { rollbackIgnoringAutoRollback } from "./db-schema";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MANIFEST = "manifest.json";
type Replacement = { name: string; incoming: string; previous: string; hadPrevious: boolean };
type Quarantine = { name: string; previous: string };
export type RestoreFiles = {
  directory: string;
  generation: string;
  files: Replacement[];
  quarantined: Quarantine[];
};

function safeName(name: unknown): name is string {
  return typeof name === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(name) && name !== "." && name !== "..";
}

function syncFile(file: string): void {
  const descriptor = fs.openSync(file, process.platform === "win32" ? "r+" : "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function syncDirectory(directory: string): void {
  // Windows 不支持用 Node 打开目录并 fsync；文件内容仍在变更前强制落盘。
  if (process.platform === "win32") return;
  syncFile(directory);
}

function writeDurable(file: string, bytes: Buffer | string): void {
  const descriptor = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function copyDurable(from: string, to: string, exclusive = false): void {
  fs.copyFileSync(from, to, exclusive ? fs.constants.COPYFILE_EXCL : 0);
  syncFile(to);
}

/** 所有旧文件副本和新文件先落盘，再发布清单；清单发布前不改变正式头像。 */
export function stageRestoreFiles(staged: ValidatedBackupHandle, uploads: string): RestoreFiles {
  fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(uploads, 0o700);
  const generation = randomUUID();
  const directory = path.join(uploads, `.restore-${generation}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const plan: RestoreFiles = { directory, generation, files: [], quarantined: [] };
  try {
    for (const file of staged.files) {
      if (!safeName(file.name)) throw new Error("非法存储路径");
      const identity = randomUUID();
      const incoming = `${identity}.incoming`;
      const previous = `${identity}.previous`;
      plan.files.push({ name: file.name, incoming, previous, hadPrevious: false });
      writeDurable(path.join(directory, incoming), staged.readFileBytes(file.name));
    }
    return plan;
  } catch (error) {
    try { cleanupRestoreFiles(plan); }
    catch (cleanupError) {
      logCleanupFailure({ error: cleanupError, context: { operation: "cleanup avatar staging", resource: "restore-avatar-files" } });
    }
    throw error;
  }
}

export function prepareRestoreFiles(plan: RestoreFiles, referenced: Set<string>): void {
  const uploads = path.dirname(plan.directory);
  for (const entry of fs.readdirSync(uploads, { withFileTypes: true })) {
    if (entry.isFile() && safeName(entry.name) && !referenced.has(entry.name)) {
      plan.quarantined.push({ name: entry.name, previous: `${randomUUID()}.obsolete` });
    }
  }
  for (const file of plan.files) {
    if (!referenced.has(file.name)) continue;
    const target = path.join(uploads, file.name);
    if (!fs.existsSync(target)) continue;
    if (!fs.lstatSync(target).isFile()) throw new Error("头像目标不是普通文件");
    copyDurable(target, path.join(plan.directory, file.previous), true);
    file.hadPrevious = true;
  }
  // 不参与恢复的新文件仍留在暂存区，仅记录确实会修改正式目录的条目。
  const manifest = { version: 1, generation: plan.generation, files: plan.files.filter(file => referenced.has(file.name)), quarantined: plan.quarantined };
  const temporary = path.join(plan.directory, "manifest.tmp");
  writeDurable(temporary, JSON.stringify(manifest));
  fs.renameSync(temporary, path.join(plan.directory, MANIFEST));
  syncDirectory(plan.directory);
  syncDirectory(uploads);
}

export function promoteRestoreFiles(plan: RestoreFiles, referenced: Set<string>): void {
  const uploads = path.dirname(plan.directory);
  for (const file of plan.quarantined) {
    fs.renameSync(path.join(uploads, file.name), path.join(plan.directory, file.previous));
  }
  for (const file of plan.files) {
    if (referenced.has(file.name)) fs.renameSync(path.join(plan.directory, file.incoming), path.join(uploads, file.name));
  }
  syncDirectory(plan.directory);
  syncDirectory(uploads);
}

/** 回滚只复制旧字节，不消耗副本；重启补偿被再次中断也能安全重试。 */
export function rollbackRestoreFiles(plan: RestoreFiles): void {
  const uploads = path.dirname(plan.directory);
  for (const file of plan.files) {
    const previous = path.join(plan.directory, file.previous);
    const target = path.join(uploads, file.name);
    if (file.hadPrevious) {
      if (!fs.existsSync(previous)) throw new Error("恢复头像副本缺失，请保留灾备快照并手动回退");
      copyDurable(previous, target);
    } else if (!fs.existsSync(path.join(plan.directory, file.incoming))) {
      fs.rmSync(target, { force: true });
    }
  }
  for (const file of plan.quarantined) {
    const previous = path.join(plan.directory, file.previous);
    if (fs.existsSync(previous)) copyDurable(previous, path.join(uploads, file.name));
  }
  syncDirectory(uploads);
}

function validateDirectory(directory: string): fs.Dirent[] {
  const allowed = new RegExp(`^(?:${UUID}\\.(?:incoming|previous|obsolete)|manifest\\.(?:json|tmp))$`);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile() || !allowed.test(entry.name))) throw new Error("恢复暂存目录内容无效");
  return entries;
}

function cleanDirectory(directory: string): void {
  if (!fs.existsSync(directory)) return;
  const entries = validateDirectory(directory);
  // 完成补偿后先撤销清单并落盘，避免清理部分副本后的再次启动被误判为未完成回滚。
  fs.rmSync(path.join(directory, MANIFEST), { force: true });
  syncDirectory(directory);
  for (const entry of entries) fs.rmSync(path.join(directory, entry.name), { force: true });
  fs.rmdirSync(directory);
  syncDirectory(path.dirname(directory));
}

export function cleanupRestoreFiles(plan: RestoreFiles): void {
  cleanDirectory(plan.directory);
}

function readPlan(directory: string): RestoreFiles {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), "utf8"));
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const invalid = () => { throw new Error("恢复文件清单无效，请保留灾备快照并手动回退"); };
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.generation !== "string" || path.basename(directory) !== `.restore-${raw.generation}` ||
      !Array.isArray(raw.files) || !Array.isArray(raw.quarantined)) return invalid();
  const slot = (value: unknown, extension: string) => typeof value === "string" && new RegExp(`^${UUID}\\.${extension}$`).test(value);
  const names = new Set<string>();
  const slots = new Set<string>();
  for (const file of [...raw.files, ...raw.quarantined]) {
    if (!isRecord(file) || !safeName(file.name) || names.has(file.name)) return invalid();
    names.add(file.name);
    const replacement = "incoming" in file;
    if (!slot(file.previous, replacement ? "previous" : "obsolete") || slots.has(String(file.previous))) return invalid();
    slots.add(String(file.previous));
    if (replacement) {
      if (!slot(file.incoming, "incoming") || typeof file.hadPrevious !== "boolean" || slots.has(String(file.incoming))) return invalid();
      slots.add(String(file.incoming));
    }
  }
  return { directory, generation: raw.generation, files: raw.files as Replacement[], quarantined: raw.quarantined as Quarantine[] };
}

/** 调用者必须持有 BEGIN IMMEDIATE 写锁；连续恢复前也必须先完成上次的补偿/清理。 */
export function recoverRestoreFiles(database: DatabaseSync, uploads: string): void {
  if (!fs.existsSync(uploads)) return;
  const row = database.prepare("SELECT data_generation FROM runtime_state WHERE id = 1").get() as { data_generation: string } | undefined;
  for (const entry of fs.readdirSync(uploads, { withFileTypes: true })) {
    if (!new RegExp(`^\\.restore-${UUID}$`).test(entry.name)) continue;
    if (entry.isFile()) continue; // 同名普通文件不属于恢复暂存目录。
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("恢复暂存目录无效");
    const directory = path.join(uploads, entry.name);
    validateDirectory(directory);
    if (fs.existsSync(path.join(directory, MANIFEST))) {
      const plan = readPlan(directory);
      if (row?.data_generation !== plan.generation) rollbackRestoreFiles(plan);
      cleanupRestoreFiles(plan);
    } else {
      // 尚未发布清单，或补偿已经完成并撤销清单；此时正式头像均无需变更。
      cleanDirectory(directory);
    }
    logServerEvent("info", "backup.restoreRecovery", { context: { resource: "avatar-files" } });
  }
}

/** 首次打开数据库时持有同一写锁，避免补偿另一个仍在进行中的恢复。 */
export function recoverPendingRestoreFiles(database: DatabaseSync, uploads: string): void {
  if (!fs.existsSync(uploads)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    recoverRestoreFiles(database, uploads);
    database.exec("COMMIT");
  } catch (error) {
    rollbackIgnoringAutoRollback(database, error);
    throw error;
  }
}
