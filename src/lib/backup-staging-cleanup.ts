import { logCleanupFailure } from "@/lib/server-errors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const RESTORE_DIRECTORY_PREFIX = "resume-life-restore-";
export const RESTORE_OWNER_FILE = ".owner";
const STALE_RESTORE_MS = 24 * 60 * 60 * 1000;

export type RestoreStagingSummary = {
  count: number;
  oldestAgeMs: number | null;
};

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readRestoreOwner(directory: string): { pid: number; createdAt: number; dev: bigint; ino: bigint } | null {
  try {
    const ownerPath = path.join(directory, RESTORE_OWNER_FILE);
    const stats = fs.lstatSync(ownerPath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > BigInt(128)) return null;
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { pid?: unknown; createdAt?: unknown };
    if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 ||
        !Number.isSafeInteger(owner.createdAt)) return null;
    return { pid: owner.pid as number, createdAt: owner.createdAt as number, dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

function reportStaleCleanupFailure(operation: string, error: unknown): void {
  try {
    logCleanupFailure({ error, context: { operation, resource: "restore-staging" } });
  } catch {
    // Logging failure must not block startup or restore.
  }
}

/** 只返回低基数摘要，不把暂存目录名称或本机路径暴露给健康检查调用方。 */
export function inspectRestoreStaging(): RestoreStagingSummary {
  const root = path.resolve(os.tmpdir());
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { count: 0, oldestAgeMs: null };
  }
  const now = Date.now();
  let count = 0;
  let oldestAgeMs: number | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^resume-life-restore-(?:[A-Za-z0-9]{6}|stale-[0-9a-f-]{36})$/u.test(entry.name)) continue;
    try {
      const stats = fs.lstatSync(path.join(root, entry.name));
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      count += 1;
      const ageMs = Math.max(0, now - Math.min(stats.birthtimeMs, stats.mtimeMs));
      oldestAgeMs = oldestAgeMs === null ? ageMs : Math.max(oldestAgeMs, ageMs);
    } catch {
      // 目录可能在检查期间被正常清理。
    }
  }
  return { count, oldestAgeMs };
}

/** 启动、定时巡检及下次恢复时回收崩溃残留；未知所有者和运行中进程一律保留。 */
export function cleanupStaleRestoreDirectories(): void {
  const root = path.resolve(os.tmpdir());
  let rootStats: fs.BigIntStats;
  try {
    rootStats = fs.lstatSync(root, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || !samePath(fs.realpathSync(root), root)) return;
  } catch (error) {
    reportStaleCleanupFailure("inspectRestoreRoot", error);
    return;
  }
  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    reportStaleCleanupFailure("listRestoreRoot", error);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^resume-life-restore-(?:[A-Za-z0-9]{6}|stale-[0-9a-f-]{36})$/u.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const stats = fs.lstatSync(directory, { bigint: true });
      if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(fs.realpathSync(directory), directory)) continue;
      const owner = readRestoreOwner(directory);
      if (!owner || owner.createdAt > now ||
          Math.max(owner.createdAt, Number(stats.mtimeMs)) > now - STALE_RESTORE_MS ||
          processIsAlive(owner.pid)) continue;
      const currentRoot = fs.lstatSync(root, { bigint: true });
      const current = fs.lstatSync(directory, { bigint: true });
      if (currentRoot.dev !== rootStats.dev || currentRoot.ino !== rootStats.ino ||
          !current.isDirectory() || current.isSymbolicLink() ||
          current.dev !== stats.dev || current.ino !== stats.ino) continue;
      const isolated = path.join(root, `${RESTORE_DIRECTORY_PREFIX}stale-${randomUUID()}`);
      fs.renameSync(directory, isolated);
      const isolatedStats = fs.lstatSync(isolated, { bigint: true });
      const isolatedOwner = readRestoreOwner(isolated);
      if (!isolatedStats.isDirectory() || isolatedStats.isSymbolicLink() ||
          isolatedStats.dev !== stats.dev || isolatedStats.ino !== stats.ino ||
          !isolatedOwner || isolatedOwner.dev !== owner.dev || isolatedOwner.ino !== owner.ino ||
          isolatedOwner.pid !== owner.pid || isolatedOwner.createdAt !== owner.createdAt ||
          processIsAlive(isolatedOwner.pid)) continue;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          fs.rmSync(isolated, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
          break;
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
    } catch (error) {
      reportStaleCleanupFailure("cleanupStaleRestoreDirectory", error);
    }
  }
}
