import { Buffer } from "node:buffer";
import { validateBackupSequences, type BackupSequences } from "@/lib/backup";
import { invalidDomainColumn } from "@/lib/backup-domain";
import {
  BACKUP_FILE_CHUNK_BYTES,
  MAX_BACKUP_FILE_BYTES,
  MAX_BACKUP_FILE_CHUNKS,
  MAX_BACKUP_FILES,
  assertBackupFieldBytes,
  assertBackupTableRows,
  assertBackupTotalRows,
} from "@/lib/backup-limits";
import {
  BACKUP_CONTAINER_VERSION,
  type BackupFileEntry,
  type EndRecord,
  type ManifestRecord,
} from "@/lib/backup-records";

export class BackupStagingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupStagingError";
  }
}

export type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

/** 与 upload-storage 的 SAFE_FILENAME 同源：只允许单段文件名，杜绝路径穿越 */
const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeFilename(name: string): boolean {
  return SAFE_FILENAME.test(name) && name !== "." && name !== "..";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validateFileEntries(value: unknown): BackupFileEntry[] {
  if (!Array.isArray(value)) throw new BackupStagingError("备份 manifest 的头像清单无效");
  if (value.length > MAX_BACKUP_FILES) {
    throw new BackupStagingError(`备份头像文件数量超过限制：${value.length} > ${MAX_BACKUP_FILES}`);
  }

  const seen = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["name", "bytes", "chunks"]) ||
        typeof entry.name !== "string" || !isSafeFilename(entry.name)) {
      throw new BackupStagingError("备份 manifest 的头像清单条目无效");
    }
    if (seen.has(entry.name)) throw new BackupStagingError(`备份头像清单存在重复文件名：${entry.name}`);
    seen.add(entry.name);

    const bytes = entry.bytes;
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || (bytes as number) > MAX_BACKUP_FILE_BYTES) {
      throw new BackupStagingError(`备份头像文件大小无效：${entry.name}`);
    }
    const chunks = entry.chunks;
    if (!Number.isSafeInteger(chunks) || (chunks as number) < 1 || (chunks as number) > MAX_BACKUP_FILE_CHUNKS) {
      throw new BackupStagingError(`备份头像文件分块数无效：${entry.name}`);
    }
    if ((chunks as number) !== Math.max(1, Math.ceil((bytes as number) / BACKUP_FILE_CHUNK_BYTES))) {
      throw new BackupStagingError(`备份头像文件分块数与大小不匹配：${entry.name}`);
    }
    return { name: entry.name, bytes: bytes as number, chunks: chunks as number };
  });
}

export function validateManifest(value: Record<string, unknown>, tables: readonly string[]): ManifestRecord {
  const manifestTables = value.tables;
  if (!hasExactKeys(
        value,
        ["kind", "appName", "backupVersion", "dbVersion", "createdAt", "tables", "sequences", "files"],
      ) ||
      value.kind !== "manifest" || value.appName !== "resume-life") {
    throw new BackupStagingError("备份 manifest 无效");
  }
  // 先于表清单比较：表清单会随业务表增加而变化，版本不符时应给出「版本不支持」而非误导性的「备份损坏」。
  if (value.backupVersion !== BACKUP_CONTAINER_VERSION) {
    throw new BackupStagingError(`不支持此备份版本：仅接受格式 ${BACKUP_CONTAINER_VERSION} 的加密备份`);
  }
  if (!Number.isSafeInteger(value.dbVersion) || !isCanonicalIsoDate(value.createdAt) || !Array.isArray(manifestTables) ||
      manifestTables.length !== tables.length || !tables.every((table, index) => manifestTables[index] === table)) {
    throw new BackupStagingError("备份 manifest 无效");
  }
  let sequences: BackupSequences;
  try {
    sequences = validateBackupSequences(value.sequences);
  } catch (error) {
    throw new BackupStagingError(error instanceof Error ? error.message : "备份序列无效", { cause: error });
  }
  const files = validateFileEntries(value.files);
  return {
    kind: "manifest",
    appName: "resume-life",
    backupVersion: BACKUP_CONTAINER_VERSION,
    dbVersion: value.dbVersion as number,
    createdAt: value.createdAt as string,
    tables: manifestTables as string[],
    sequences,
    files,
  };
}

export function validateEnd(value: Record<string, unknown>, tables: readonly string[]): EndRecord {
  if (!hasExactKeys(value, ["kind", "stats", "totalRecords", "files"]) || value.kind !== "end" ||
      !isRecord(value.stats) || !hasExactKeys(value.stats, tables) || !Number.isSafeInteger(value.totalRecords) ||
      (value.totalRecords as number) < 0) {
    throw new BackupStagingError("备份 end 记录或统计无效");
  }
  if (!Number.isSafeInteger(value.files) || (value.files as number) < 0 || (value.files as number) > MAX_BACKUP_FILES) {
    throw new BackupStagingError("备份 end 记录的头像文件数无效");
  }

  for (const table of tables) {
    const count = value.stats[table];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new BackupStagingError(`备份统计无效：${table}`);
    }
    assertBackupTableRows(count as number);
  }
  assertBackupTotalRows(value.totalRecords as number);
  return value as EndRecord;
}

export function validateRowData(
  table: string,
  rowNumber: number,
  data: unknown,
  columns: readonly ColumnInfo[],
): Record<string, unknown> {
  if (!isRecord(data) || !hasExactKeys(data, columns.map((column) => column.name))) {
    throw new BackupStagingError(`备份数据损坏：${table} 第 ${rowNumber} 行的列集合无效`);
  }

  for (const column of columns) {
    const value = data[column.name];
    if (value === null) {
      if (column.notnull || column.pk) {
        throw new BackupStagingError(`备份数据损坏：${table} 第 ${rowNumber} 行 ${column.name} 不可为空`);
      }
    } else if (column.type.toUpperCase() === "INTEGER") {
      if (!Number.isSafeInteger(value)) {
        throw new BackupStagingError(`备份数据损坏：${table} 第 ${rowNumber} 行 ${column.name} 不是安全整数`);
      }
    } else if (column.type.toUpperCase() === "TEXT") {
      if (typeof value !== "string") {
        throw new BackupStagingError(`备份数据损坏：${table} 第 ${rowNumber} 行 ${column.name} 不是字符串`);
      }
      assertBackupFieldBytes(Buffer.byteLength(value, "utf8"));
    } else {
      throw new BackupStagingError(`源数据库含不支持的列类型：${table}.${column.name}`);
    }
  }

  const invalidColumn = invalidDomainColumn(table, data);
  if (invalidColumn) {
    throw new BackupStagingError(`备份数据损坏：${table} 第 ${rowNumber} 行 ${invalidColumn} 字段不是有效的领域 JSON`);
  }
  return data;
}
