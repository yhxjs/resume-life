import { logCleanupFailure } from "@/lib/server-errors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { TABLES_INSERT_ORDER, type BackupSequences } from "@/lib/backup";
import type { BackupFileEntry, EndRecord, ManifestRecord } from "@/lib/backup-records";
import { errorMessage } from "@/lib/error-message";
import { RESTORE_DIRECTORY_PREFIX, RESTORE_OWNER_FILE } from "@/lib/backup-staging-cleanup";
import { BackupStagingError, type ColumnInfo } from "@/lib/backup-staging-validation";

export { RESTORE_DIRECTORY_PREFIX, cleanupStaleRestoreDirectories, inspectRestoreStaging } from "@/lib/backup-staging-cleanup";
const CLEANUP_ATTEMPTS = 3;
/** 暂存目录下存放头像文件的子目录 */
export const STAGED_FILES_DIRECTORY = "files";

type StagedRow = {
  cursor: number;
  data: Record<string, unknown>;
};

export type StagedBackup = {
  readonly manifest: ManifestRecord;
  readonly stats: Readonly<Record<string, number>>;
  readonly sequences: Readonly<BackupSequences>;
  readonly totalRecords: number;
  readonly files: readonly BackupFileEntry[];
  readonly temporaryDirectory: string;
  readTableBatch(table: string, afterRowId?: number, limit?: number): StagedRow[];
  readFileBytes(name: string): Buffer;
  dispose(): void;
};

type CleanupFailure = {
  operation: string;
  target: string;
  message: string;
};

type ErrorWithCleanupFailures = Error & {
  cleanupFailures?: CleanupFailure[];
};

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function createRestoreTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), RESTORE_DIRECTORY_PREFIX));
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(path.join(directory, RESTORE_OWNER_FILE),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      removeTemporaryDirectory(directory);
    } catch (cleanupError) {
      reportCleanupFailure(error, "removeTemporaryDirectory", directory, cleanupError);
    }
    throw error;
  }
  return directory;
}

export function removeTemporaryDirectory(temporaryDirectory: string): void {
  const resolved = path.resolve(temporaryDirectory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(RESTORE_DIRECTORY_PREFIX)) {
    throw new BackupStagingError("拒绝清理不安全的暂存目录");
  }
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === CLEANUP_ATTEMPTS) throw error;
    }
  }
}

function cleanupErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  return message
    .replace(/\bsk-[A-Za-z0-9_-]+\b/giu, "[REDACTED]")
    .replace(/((?:api[_ -]?key|password|ciphertext|secret|token)\s*[:=]\s*)\S+/giu, "$1[REDACTED]")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 256);
}

export function reportCleanupFailure(
  primaryError: unknown,
  operation: string,
  temporaryDirectory: string,
  cleanupError: unknown,
): void {
  const failure: CleanupFailure = {
    operation,
    target: path.basename(temporaryDirectory),
    message: cleanupErrorMessage(cleanupError),
  };
  if (primaryError instanceof Error) {
    try {
      const error = primaryError as ErrorWithCleanupFailures;
      if (error.cleanupFailures) {
        error.cleanupFailures.push(failure);
      } else {
        Object.defineProperty(error, "cleanupFailures", {
          configurable: true,
          enumerable: false,
          value: [failure],
        });
      }
    } catch {
      // Cleanup reporting must not replace the primary staging error.
    }
  }
  try {
    logCleanupFailure({ error: cleanupError, context: { operation, resource: failure.target } });
  } catch {
    // Logging failure must not replace the primary staging error.
  }
}

export function copySchemas(sourceDatabase: DatabaseSync, stagingDatabase: DatabaseSync): Map<string, ColumnInfo[]> {
  const columns = new Map<string, ColumnInfo[]>();
  for (const table of TABLES_INSERT_ORDER) {
    const schema = sourceDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { sql?: unknown } | undefined;
    if (typeof schema?.sql !== "string") {
      throw new BackupStagingError(`源数据库缺少表结构：${table}`);
    }
    stagingDatabase.exec(schema.sql);
    const tableColumns = sourceDatabase.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as ColumnInfo[];
    if (tableColumns.length === 0) throw new BackupStagingError(`源数据库缺少列结构：${table}`);
    columns.set(table, tableColumns);
  }
  return columns;
}

export function createStagedBackup(
  database: DatabaseSync,
  temporaryDirectory: string,
  manifest: ManifestRecord,
  end: EndRecord,
  allowedTables: ReadonlySet<string>,
): StagedBackup {
  let databaseClosed = false;
  let directoryRemoved = false;
  const frozenFiles: readonly BackupFileEntry[] = Object.freeze(
    manifest.files.map((file) => Object.freeze({ ...file })),
  );
  const frozenManifest: ManifestRecord = Object.freeze({
    ...manifest,
    tables: Object.freeze([...manifest.tables]),
    sequences: Object.freeze({ ...manifest.sequences }),
    files: frozenFiles,
  });
  const frozenStats: Readonly<Record<string, number>> = Object.freeze({ ...end.stats });
  const frozenSequences: Readonly<BackupSequences> = Object.freeze({ ...manifest.sequences });
  const filesByName = new Map(frozenFiles.map((file) => [file.name, file]));
  return {
    manifest: frozenManifest,
    stats: frozenStats,
    sequences: frozenSequences,
    totalRecords: end.totalRecords,
    files: frozenFiles,
    temporaryDirectory,
    readFileBytes(name) {
      if (databaseClosed) throw new BackupStagingError("暂存备份已释放");
      const entry = filesByName.get(name);
      // 名字必须来自清单：否则调用方就能借暂存目录读写任意路径
      if (!entry) throw new BackupStagingError(`未知头像文件：${name}`);
      return fs.readFileSync(path.join(temporaryDirectory, STAGED_FILES_DIRECTORY, name));
    },
    readTableBatch(table, afterRowId, limit = 200) {
      if (databaseClosed) throw new BackupStagingError("暂存备份已释放");
      if (!allowedTables.has(table)) throw new BackupStagingError(`未知表：${table}`);
      if (afterRowId !== undefined && !Number.isSafeInteger(afterRowId)) {
        throw new BackupStagingError("afterRowId 必须是安全整数");
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new BackupStagingError("limit 必须是 1..200 的安全整数");
      }
      const rows = (afterRowId === undefined
        ? database.prepare(
          `SELECT rowid AS __backup_cursor__, * FROM ${quoteIdentifier(table)} ORDER BY rowid LIMIT ?`,
        ).all(limit)
        : database.prepare(
          `SELECT rowid AS __backup_cursor__, * FROM ${quoteIdentifier(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        ).all(afterRowId, limit)) as Array<Record<string, unknown> & { __backup_cursor__: unknown }>;
      return rows.map((row) => {
        const cursor = row.__backup_cursor__;
        if (!Number.isSafeInteger(cursor)) throw new BackupStagingError(`暂存游标无效：${table}`);
        const data: Record<string, unknown> = { ...row };
        delete data.__backup_cursor__;
        return { cursor: cursor as number, data };
      });
    },
    dispose() {
      let cleanupError: unknown;
      if (!databaseClosed) {
        try {
          database.close();
          databaseClosed = true;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (databaseClosed && !directoryRemoved) {
        try {
          removeTemporaryDirectory(temporaryDirectory);
          directoryRemoved = true;
        } catch (error) {
          if (cleanupError === undefined) cleanupError = error;
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
    },
  };
}
