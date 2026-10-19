import { logCleanupFailure } from "@/lib/server-errors";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db";
import { listReferencedUploadFilenames, readUploadFileForSnapshot } from "@/lib/upload-storage";

export const MAX_PRE_RESTORE_SNAPSHOTS = 5;
export const MIN_SNAPSHOT_BUDGET_BYTES = 256 * 1024 * 1024;
export const SNAPSHOT_DATABASE_MULTIPLIER = 3;

const PRE_RESTORE_SNAPSHOT_PREFIX = "resume-life.db.pre-restore-";
const QUARANTINE_MARKER = ".quarantine-";

type BackupStoragePaths = {
  databasePath: string;
  backupDir: string;
};

type BackupDirectoryIdentity = {
  realPath: string;
  dev: bigint;
  ino: bigint;
};

export type CreatedPreRestoreSnapshot = {
  path: string;
  directoryIdentity: BackupDirectoryIdentity;
  snapshotIdentity: SnapshotIdentity;
  uploadsIdentity?: SnapshotIdentity;
};

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function getBackupStoragePaths(database: DatabaseSync): BackupStoragePaths {
  const main = (database.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find((entry) => entry.name === "main");
  if (!main?.file) throw new Error("无法定位当前数据库，已取消恢复");
  const databasePath = fs.realpathSync(main.file);
  return {
    databasePath,
    backupDir: path.join(path.dirname(databasePath), "backups"),
  };
}

function inspectBackupDirectory(backupDir: string): BackupDirectoryIdentity {
  const stats = fs.lstatSync(backupDir, { bigint: true });
  const realPath = fs.realpathSync(backupDir);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePath(realPath, backupDir)) {
    throw new Error("备份目录不安全");
  }
  return { realPath, dev: stats.dev, ino: stats.ino };
}

function sameBackupDirectory(
  left: BackupDirectoryIdentity,
  right: BackupDirectoryIdentity,
): boolean {
  return samePath(left.realPath, right.realPath) && left.dev === right.dev && left.ino === right.ino;
}

/** 灾备：在覆写前保存 SQLite 和它引用的头像。 */
export function createPreRestoreSnapshot(separateConnection = false): CreatedPreRestoreSnapshot {
  const database = getDb();
  const { backupDir, databasePath } = getBackupStoragePaths(database);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(backupDir, 0o700);
  const backupDirectoryIdentity = inspectBackupDirectory(backupDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(backupDir, `${PRE_RESTORE_SNAPSHOT_PREFIX}${timestamp}-${randomUUID()}`);
  const currentBackupDirectoryIdentity = inspectBackupDirectory(backupDir);
  if (!sameBackupDirectory(backupDirectoryIdentity, currentBackupDirectoryIdentity)) {
    throw new Error("备份目录身份已变化，已取消恢复");
  }
  // 先创建空目标并记录身份；VACUUM INTO 允许写入已有的空文件。
  fs.writeFileSync(snapshotPath, "", { flag: "wx", mode: 0o600 });
  const stats = fs.lstatSync(snapshotPath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || !hasValidBigIntMetadata(stats)) {
    throw new Error("灾备快照身份无效，已取消恢复");
  }
  const created: CreatedPreRestoreSnapshot = {
    path: snapshotPath,
    directoryIdentity: backupDirectoryIdentity,
    snapshotIdentity: { dev: stats.dev, ino: stats.ino },
  };
  try {
    // SQLite 自身读取一致性快照并包含 WAL 中已提交的数据，输出独立数据库文件。
    const source = separateConnection ? new DatabaseSync(databasePath, { readOnly: true }) : database;
    try {
      source.prepare("VACUUM INTO ?").run(snapshotPath);
    } finally {
      if (separateConnection) source.close();
    }
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    let referencedUploads: Set<string>;
    try {
      const result = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      if (result.integrity_check !== "ok") throw new Error("灾备快照完整性校验失败，已取消恢复");
      referencedUploads = listReferencedUploadFilenames(snapshot);
    } finally {
      snapshot.close();
    }
    const uploadsPath = `${snapshotPath}.uploads`;
    fs.mkdirSync(uploadsPath, { mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(uploadsPath, 0o700);
    const uploads = inspectSnapshotUploads(snapshotPath);
    if (!uploads) throw new Error("灾备头像目录无效，已取消恢复");
    created.uploadsIdentity = { dev: uploads.dev, ino: uploads.ino };
    for (const name of referencedUploads) {
      const file = readUploadFileForSnapshot(name);
      if (!file) continue;
      fs.writeFileSync(path.join(uploadsPath, name), file.bytes, { flag: "wx", mode: 0o600 });
    }
    const completedUploads = inspectSnapshotUploads(snapshotPath);
    if (!completedUploads || !sameSnapshotIdentity(created.uploadsIdentity, completedUploads)) {
      throw new Error("灾备头像目录身份已变化，已取消恢复");
    }
    return created;
  } catch (error) {
    try {
      discardFailedPreRestoreSnapshot(created);
    } catch (cleanupError) {
      reportSnapshotCleanupFailure("discardIncompletePreRestoreSnapshot", cleanupError);
    }
    throw error;
  }
}

type SnapshotIdentity = {
  dev: bigint;
  ino: bigint;
};

type SnapshotCandidate = SnapshotIdentity & {
  path: string;
  databaseSize: bigint;
  size: bigint;
  mtimeNs: bigint;
  uploads?: SnapshotUploads;
};

type SnapshotUploads = SnapshotIdentity & {
  path: string;
  size: bigint;
};

function reportSnapshotCleanupFailure(operation: string, cleanupError: unknown): void {
  try {
    logCleanupFailure({ error: cleanupError, context: { operation, resource: "pre-restore-snapshot" } });
  } catch {
    // Logging failure must not replace a successful restore.
  }
}

function isSnapshotPathInDirectory(backupDir: string, target: string): boolean {
  const resolvedBackupDir = path.resolve(backupDir);
  const resolvedTarget = path.resolve(target);
  return path.dirname(resolvedTarget) === resolvedBackupDir &&
    path.basename(resolvedTarget).startsWith(PRE_RESTORE_SNAPSHOT_PREFIX);
}

function hasValidBigIntMetadata(stats: fs.BigIntStats): boolean {
  return typeof stats.size === "bigint" && stats.size >= BigInt(0) &&
    typeof stats.mtimeNs === "bigint" && stats.mtimeNs >= BigInt(0) &&
    typeof stats.dev === "bigint" && stats.dev >= BigInt(0) &&
    typeof stats.ino === "bigint" && stats.ino >= BigInt(0);
}

function sameSnapshotIdentity(left: SnapshotIdentity, right: SnapshotIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isQuarantinedSnapshotName(name: string): boolean {
  return name.startsWith(`${PRE_RESTORE_SNAPSHOT_PREFIX}quarantine-`) ||
    (name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX) && name.includes(QUARANTINE_MARKER));
}

function inspectSnapshotUploads(snapshotPath: string): SnapshotUploads | undefined {
  const uploadsPath = snapshotPath.endsWith(".uploads") ? snapshotPath : `${snapshotPath}.uploads`;
  if (!isSnapshotPathInDirectory(path.dirname(uploadsPath), uploadsPath)) {
    throw new Error("灾备头像目录路径无效");
  }
  let stats: fs.BigIntStats;
  try {
    stats = fs.lstatSync(uploadsPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || !hasValidBigIntMetadata(stats) ||
      !samePath(fs.realpathSync(uploadsPath), uploadsPath)) {
    throw new Error("灾备头像目录身份无效");
  }
  let size = BigInt(0);
  for (const entry of fs.readdirSync(uploadsPath, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.name) || entry.name === "." || entry.name === "..") {
      throw new Error("灾备头像目录包含无效文件");
    }
    const file = fs.lstatSync(path.join(uploadsPath, entry.name), { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || !hasValidBigIntMetadata(file)) {
      throw new Error("灾备头像文件身份无效");
    }
    size += file.size;
  }
  return { path: uploadsPath, size, dev: stats.dev, ino: stats.ino };
}

function removeSnapshotUploads(snapshotPath: string, identity?: SnapshotIdentity): bigint {
  const uploads = inspectSnapshotUploads(snapshotPath);
  if (!identity) {
    if (uploads) throw new Error("灾备头像目录身份未知，拒绝清理");
    return BigInt(0);
  }
  if (!uploads || !sameSnapshotIdentity(identity, uploads)) {
    throw new Error("灾备头像目录身份已变化，拒绝清理");
  }
  const isolatedPath = path.join(path.dirname(uploads.path), `${PRE_RESTORE_SNAPSHOT_PREFIX}quarantine-${randomUUID()}.uploads`);
  fs.renameSync(uploads.path, isolatedPath);
  const isolated = inspectSnapshotUploads(isolatedPath);
  if (!isolated || !sameSnapshotIdentity(identity, isolated)) {
    try { fs.renameSync(isolatedPath, uploads.path); }
    catch (cleanupError) { reportSnapshotCleanupFailure("restoreIsolatedPreRestoreUploads", cleanupError); }
    throw new Error("隔离头像目录身份已变化，拒绝清理");
  }
  for (const entry of fs.readdirSync(isolatedPath)) {
    const filePath = path.join(isolatedPath, entry);
    const file = fs.lstatSync(filePath);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("隔离头像文件身份无效，拒绝清理");
    fs.unlinkSync(filePath);
  }
  fs.rmdirSync(isolatedPath);
  return uploads.size;
}

function restoreIsolatedSnapshot(
  isolatedPath: string,
  candidatePath: string,
  identity: SnapshotIdentity,
): void {
  try {
    fs.linkSync(isolatedPath, candidatePath);
  } catch (cleanupError) {
    try {
      const isolated = fs.lstatSync(isolatedPath, { bigint: true });
      if (!isolated.isFile() || isolated.isSymbolicLink() ||
          !sameSnapshotIdentity(identity, { dev: isolated.dev, ino: isolated.ino })) {
        throw new Error("隔离快照身份已变化，拒绝恢复");
      }
      try {
        fs.lstatSync(candidatePath);
        throw new Error("原快照路径已被占用，拒绝恢复");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      fs.renameSync(isolatedPath, candidatePath);
    } catch (renameError) {
      reportSnapshotCleanupFailure("restoreIsolatedPreRestoreSnapshot", cleanupError);
      reportSnapshotCleanupFailure("renameIsolatedPreRestoreSnapshot", renameError);
    }
    return;
  }
  try {
    fs.unlinkSync(isolatedPath);
  } catch (cleanupError) {
    reportSnapshotCleanupFailure("cleanupIsolatedPreRestoreSnapshot", cleanupError);
  }
}

function cleanupOrphanSnapshotUploads(
  backupDir: string,
  directoryIdentity: BackupDirectoryIdentity,
  currentSnapshot: string,
): { remainingBytes: bigint; hasUnknownBytes: boolean } {
  let remainingBytes = BigInt(0);
  let hasUnknownBytes = false;
  const entries = fs.readdirSync(/* turbopackIgnore: true */ backupDir, { withFileTypes: true });
  const hasUnmappedQuarantine = entries.some((entry) => entry.isFile() &&
    entry.name.startsWith(`${PRE_RESTORE_SNAPSHOT_PREFIX}quarantine-`));
  for (const entry of entries) {
    if (!entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX) || !entry.name.endsWith(".uploads")) continue;
    const uploadsPath = path.join(backupDir, entry.name);
    if (!isSnapshotPathInDirectory(backupDir, uploadsPath)) continue;
    const snapshotPath = uploadsPath.slice(0, -".uploads".length);
    if (samePath(snapshotPath, currentSnapshot)) continue;
    const hasQuarantinedDatabase = hasUnmappedQuarantine || entries.some((candidate) =>
      candidate.isFile() && candidate.name.startsWith(`${path.basename(snapshotPath)}${QUARANTINE_MARKER}`));
    try {
      fs.lstatSync(snapshotPath);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        hasUnknownBytes = true;
        reportSnapshotCleanupFailure("inspectOrphanPreRestoreSnapshot", error);
        continue;
      }
    }
    try {
      const uploads = inspectSnapshotUploads(uploadsPath);
      if (!uploads) continue;
      if (!sameBackupDirectory(directoryIdentity, inspectBackupDirectory(backupDir))) {
        throw new Error("备份目录身份已变化，拒绝清理孤立头像");
      }
      if (hasQuarantinedDatabase) {
        remainingBytes += uploads.size;
        continue;
      }
      try {
        removeSnapshotUploads(uploadsPath, uploads);
      } catch (error) {
        remainingBytes += uploads.size;
        reportSnapshotCleanupFailure("removeOrphanPreRestoreUploads", error);
      }
    } catch (error) {
      hasUnknownBytes = true;
      reportSnapshotCleanupFailure("inspectOrphanPreRestoreUploads", error);
    }
  }
  return { remainingBytes, hasUnknownBytes };
}

/** 回滚成功后仅删除本次创建且身份仍相同的快照，不触碰已有灾备。 */
export function discardFailedPreRestoreSnapshot(created: CreatedPreRestoreSnapshot): void {
  const backupDir = path.dirname(created.path);
  if (!isSnapshotPathInDirectory(backupDir, created.path) ||
      !sameBackupDirectory(created.directoryIdentity, inspectBackupDirectory(backupDir))) {
    throw new Error("备份目录身份已变化，拒绝清理本次快照");
  }
  const stats = fs.lstatSync(created.path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || !hasValidBigIntMetadata(stats) ||
      !sameSnapshotIdentity(created.snapshotIdentity, { dev: stats.dev, ino: stats.ino })) {
    throw new Error("本次快照身份已变化，拒绝清理");
  }
  const isolatedPath = `${created.path}${QUARANTINE_MARKER}${randomUUID()}`;
  fs.renameSync(created.path, isolatedPath);
  const isolated = fs.lstatSync(isolatedPath, { bigint: true });
  if (!isolated.isFile() || isolated.isSymbolicLink() || !hasValidBigIntMetadata(isolated) ||
      !sameSnapshotIdentity(created.snapshotIdentity, { dev: isolated.dev, ino: isolated.ino })) {
    restoreIsolatedSnapshot(isolatedPath, created.path, created.snapshotIdentity);
    throw new Error("隔离快照身份已变化，拒绝清理");
  }
  if (created.uploadsIdentity) {
    try {
      fs.renameSync(`${created.path}.uploads`, `${isolatedPath}.uploads`);
    } catch (error) {
      restoreIsolatedSnapshot(isolatedPath, created.path, created.snapshotIdentity);
      throw error;
    }
    const isolatedUploads = inspectSnapshotUploads(isolatedPath);
    if (!isolatedUploads || !sameSnapshotIdentity(created.uploadsIdentity, isolatedUploads)) {
      throw new Error("隔离头像目录身份已变化，拒绝清理");
    }
  }
  fs.unlinkSync(isolatedPath);
  removeSnapshotUploads(isolatedPath, created.uploadsIdentity);
}

export function rotatePreRestoreSnapshots(database: DatabaseSync, snapshotCreated: string): void {
  try {
    const { backupDir, databasePath } = getBackupStoragePaths(database);
    const backupDirectoryIdentity = inspectBackupDirectory(backupDir);
    const currentSnapshot = path.resolve(snapshotCreated);
    let currentSnapshotStats: fs.BigIntStats;
    try {
      currentSnapshotStats = fs.lstatSync(currentSnapshot, { bigint: true });
    } catch (cleanupError) {
      reportSnapshotCleanupFailure("inspectCurrentPreRestoreSnapshot", cleanupError);
      return;
    }
    if (!currentSnapshotStats.isFile() || currentSnapshotStats.isSymbolicLink() ||
        !hasValidBigIntMetadata(currentSnapshotStats)) {
      reportSnapshotCleanupFailure("inspectCurrentPreRestoreSnapshot", new Error());
      return;
    }
    const currentSnapshotIdentity: SnapshotIdentity = {
      dev: currentSnapshotStats.dev,
      ino: currentSnapshotStats.ino,
    };
    const orphanUploads = cleanupOrphanSnapshotUploads(backupDir, backupDirectoryIdentity, currentSnapshot);
    const candidates: SnapshotCandidate[] = [];
    let snapshotCount = 0;
    let hasUnknownBytes = orphanUploads.hasUnknownBytes;
    let quarantinedBytes = BigInt(0);

    for (const entry of fs.readdirSync(/* turbopackIgnore: true */ backupDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(PRE_RESTORE_SNAPSHOT_PREFIX)) continue;
      // SQLite 的 `-wal` / `-shm` 附属文件同样以快照前缀开头，但它们不是快照：
      // 计进去会让 snapshotCount 翻倍、把几 MB 的 WAL 算进轮转预算，
      // 更糟的是它们能通过 isSnapshotPathInDirectory，被当成独立快照删掉——
      // 删掉主文件的附属文件就得到一个「integrity_check 仍然 ok 的空库」。
      if (entry.name.endsWith("-wal") || entry.name.endsWith("-shm") || entry.name.endsWith(".uploads")) continue;
      snapshotCount += 1;
      const candidatePath = path.join(backupDir, entry.name);
      if (!isSnapshotPathInDirectory(backupDir, candidatePath)) {
        hasUnknownBytes = true;
        reportSnapshotCleanupFailure("inspectPreRestoreSnapshot", new Error());
        continue;
      }
      try {
        const stats = fs.lstatSync(candidatePath, { bigint: true });
        if (!stats.isFile() || stats.isSymbolicLink()) {
          hasUnknownBytes = true;
          reportSnapshotCleanupFailure("inspectPreRestoreSnapshot", new Error());
          continue;
        }
        if (!hasValidBigIntMetadata(stats)) {
          reportSnapshotCleanupFailure("inspectPreRestoreSnapshot", new Error());
          return;
        }
        if (isQuarantinedSnapshotName(entry.name)) {
          const quarantinedUploads = inspectSnapshotUploads(candidatePath);
          quarantinedBytes += stats.size + (quarantinedUploads?.size ?? BigInt(0));
          continue;
        }
        const uploads = inspectSnapshotUploads(candidatePath);
        candidates.push({
          path: candidatePath,
          databaseSize: stats.size,
          size: stats.size + (uploads?.size ?? BigInt(0)),
          mtimeNs: stats.mtimeNs,
          dev: stats.dev,
          ino: stats.ino,
          uploads,
        });
      } catch (cleanupError) {
        hasUnknownBytes = true;
        reportSnapshotCleanupFailure("inspectPreRestoreSnapshot", cleanupError);
      }
    }

    const databaseStats = fs.lstatSync(databasePath, { bigint: true });
    if (!databaseStats.isFile() || databaseStats.isSymbolicLink() || !hasValidBigIntMetadata(databaseStats)) {
      reportSnapshotCleanupFailure("inspectCurrentDatabase", new Error());
      return;
    }

    candidates.sort((left, right) => {
      if (left.mtimeNs === right.mtimeNs) return right.path.localeCompare(left.path);
      return left.mtimeNs > right.mtimeNs ? -1 : 1;
    });
    let totalBytes = candidates.reduce((total, candidate) => total + candidate.size,
      orphanUploads.remainingBytes + quarantinedBytes);
    const databaseBudgetBytes = databaseStats.size * BigInt(SNAPSHOT_DATABASE_MULTIPLIER);
    const minimumBudgetBytes = BigInt(MIN_SNAPSHOT_BUDGET_BYTES);
    const budgetBytes = databaseBudgetBytes > minimumBudgetBytes
      ? databaseBudgetBytes
      : minimumBudgetBytes;

    for (let index = candidates.length - 1;
      index >= 0 && (
        snapshotCount > MAX_PRE_RESTORE_SNAPSHOTS ||
        hasUnknownBytes ||
        totalBytes > budgetBytes
      );
      index -= 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      if (samePath(candidate.path, currentSnapshot)) continue;
      if (!isSnapshotPathInDirectory(backupDir, candidate.path)) continue;
      try {
        const currentDirectoryIdentity = inspectBackupDirectory(backupDir);
        if (!sameBackupDirectory(backupDirectoryIdentity, currentDirectoryIdentity)) {
          reportSnapshotCleanupFailure("verifyBackupDirectory", new Error());
          return;
        }
      } catch (cleanupError) {
        reportSnapshotCleanupFailure("verifyBackupDirectory", cleanupError);
        return;
      }

      let currentCandidate: fs.BigIntStats;
      try {
        currentCandidate = fs.lstatSync(candidate.path, { bigint: true });
      } catch (cleanupError) {
        reportSnapshotCleanupFailure("verifyPreRestoreSnapshot", cleanupError);
        continue;
      }
      if (!currentCandidate.isFile() || currentCandidate.isSymbolicLink() ||
          !hasValidBigIntMetadata(currentCandidate) ||
          currentCandidate.dev !== candidate.dev || currentCandidate.ino !== candidate.ino) {
        reportSnapshotCleanupFailure("verifyPreRestoreSnapshot", new Error());
        continue;
      }
      try {
        const currentUploads = inspectSnapshotUploads(candidate.path);
        if (Boolean(currentUploads) !== Boolean(candidate.uploads) ||
            (currentUploads && candidate.uploads && !sameSnapshotIdentity(currentUploads, candidate.uploads))) {
          reportSnapshotCleanupFailure("verifyPreRestoreUploads", new Error());
          continue;
        }
      } catch (cleanupError) {
        reportSnapshotCleanupFailure("verifyPreRestoreUploads", cleanupError);
        continue;
      }

      const isolatedPath = `${candidate.path}${QUARANTINE_MARKER}${randomUUID()}`;
      try {
        fs.renameSync(candidate.path, isolatedPath);
      } catch (cleanupError) {
        reportSnapshotCleanupFailure("isolatePreRestoreSnapshot", cleanupError);
        continue;
      }

      let isolatedCandidate: fs.BigIntStats;
      try {
        isolatedCandidate = fs.lstatSync(isolatedPath, { bigint: true });
      } catch (cleanupError) {
        reportSnapshotCleanupFailure("verifyIsolatedPreRestoreSnapshot", cleanupError);
        restoreIsolatedSnapshot(isolatedPath, candidate.path, candidate);
        continue;
      }
      const isolatedIdentity: SnapshotIdentity = {
        dev: isolatedCandidate.dev,
        ino: isolatedCandidate.ino,
      };
      if (!isolatedCandidate.isFile() || isolatedCandidate.isSymbolicLink() ||
          !hasValidBigIntMetadata(isolatedCandidate) ||
          !sameSnapshotIdentity(isolatedIdentity, candidate) ||
          sameSnapshotIdentity(isolatedIdentity, currentSnapshotIdentity)) {
        reportSnapshotCleanupFailure("verifyIsolatedPreRestoreSnapshot", new Error());
        restoreIsolatedSnapshot(isolatedPath, candidate.path, candidate);
        continue;
      }

      if (candidate.uploads) {
        try {
          fs.renameSync(candidate.uploads.path, `${isolatedPath}.uploads`);
        } catch (cleanupError) {
          reportSnapshotCleanupFailure("isolatePreRestoreUploads", cleanupError);
          restoreIsolatedSnapshot(isolatedPath, candidate.path, candidate);
          continue;
        }
        try {
          const isolatedUploads = inspectSnapshotUploads(isolatedPath);
          if (!isolatedUploads || !sameSnapshotIdentity(candidate.uploads, isolatedUploads)) {
            throw new Error("隔离头像目录身份已变化，拒绝清理");
          }
        } catch (cleanupError) {
          reportSnapshotCleanupFailure("verifyIsolatedPreRestoreUploads", cleanupError);
          continue;
        }
      }

      try {
        fs.unlinkSync(isolatedPath);
        snapshotCount -= 1;
        totalBytes -= candidate.databaseSize;
        try {
          totalBytes -= removeSnapshotUploads(isolatedPath, candidate.uploads);
        } catch (cleanupError) {
          reportSnapshotCleanupFailure("removePreRestoreUploads", cleanupError);
        }
      } catch (cleanupError) {
        reportSnapshotCleanupFailure("removePreRestoreSnapshot", cleanupError);
      }
    }
  } catch (cleanupError) {
    reportSnapshotCleanupFailure("rotatePreRestoreSnapshots", cleanupError);
  }
}
