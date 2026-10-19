import { logCleanupFailure } from "@/lib/server-errors";
import { Buffer } from "node:buffer";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readBackupSequences, TABLES_CLEAR_ORDER, type BackupSequences } from "@/lib/backup";
import { invalidDomainColumn, validateResumeVersionRelations } from "@/lib/backup-domain";
import { CURRENT_DB_VERSION, validateDatabaseSchema } from "@/lib/db";
import {
  BACKUP_BATCH_SIZE,
  BACKUP_FILE_CHUNK_BYTES,
  MAX_BACKUP_FILE_BYTES,
  MAX_BACKUP_FILES,
  assertBackupFieldBytes,
  assertBackupPlaintextBytes,
  assertBackupRecordBytes,
  assertBackupTableRows,
  assertBackupTotalRows,
} from "@/lib/backup-limits";
import { avatarUrlFromContent, listReferencedUploadFilenames, listUploadFilenames, readUploadBytes, uploadFileSize, uploadPathFromUrl, UPLOAD_URL_PREFIX } from "@/lib/upload-storage";
import type { ResumeSnapshot } from "./resume-version-types";

export const BACKUP_CONTAINER_VERSION = "1.0.0";

/** 备份里一个头像文件的清单条目 */
export type BackupFileEntry = {
  name: string;
  bytes: number;
  chunks: number;
};

export type ManifestRecord = {
  kind: "manifest";
  appName: "resume-life";
  backupVersion: typeof BACKUP_CONTAINER_VERSION;
  dbVersion: number;
  createdAt: string;
  tables: readonly string[];
  sequences: BackupSequences;
  files: readonly BackupFileEntry[];
};

export type RowRecord = {
  kind: "row";
  table: string;
  data: Record<string, unknown>;
};

/**
 * 头像文件的一个分块。
 *
 * 分块而不是整文件一条记录，是因为暂存端的行缓冲上限就是 MAX_BACKUP_FIELD_BYTES：
 * 超过 2 MiB 的记录在解析前就进不了缓冲区。data 是 base64，因此原始字节上限
 * 取 BACKUP_FILE_CHUNK_BYTES（1 MiB）以留足编码膨胀与 JSON 结构开销的余量。
 */
export type FileRecord = {
  kind: "file";
  name: string;
  index: number;
  data: string;
};

export type EndRecord = {
  kind: "end";
  stats: Record<string, number>;
  totalRecords: number;
  files: number;
};

export type BackupRecordOptions = {
  /** 用户备份设为 false，设备绑定的密文也不携带；内部快照保留原始值。 */
  includeSensitiveSettings?: boolean;
};

export type BackupRecord = ManifestRecord | RowRecord | FileRecord | EndRecord;

export class BackupRecordError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupRecordError";
  }
}

type CleanupFailure = {
  operation: string;
  target: string;
  message: string;
};

type ErrorWithCleanupFailures = Error & {
  cleanupFailures?: CleanupFailure[];
};

function cleanupErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  if (error === null) return "null";
  return typeof error;
}

function reportCleanupFailure(
  primaryError: unknown,
  operation: string,
  target: string,
  cleanupError: unknown,
): void {
  const failure: CleanupFailure = {
    operation,
    target,
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
      // Cleanup reporting must not replace the primary export error.
    }
  }
  try {
    logCleanupFailure({ error: cleanupError, context: { operation, resource: target } });
  } catch {
    // Logging failure must not replace the primary export error.
  }
}

function assertStringBytes(value: string): void {
  assertBackupFieldBytes(Buffer.byteLength(value, "utf8"));
}

function assertRowValues(table: string, rowNumber: number, data: Record<string, unknown>): void {
  for (const [column, value] of Object.entries(data)) {
    if (typeof value === "string") {
      assertStringBytes(value);
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new BackupRecordError(`备份字段无效：${table} 第 ${rowNumber} 行 ${column} 不是安全整数`);
      }
    } else if (value !== null) {
      throw new BackupRecordError(`备份字段无效：${table} 第 ${rowNumber} 行 ${column} 只能是 string、safe integer 或 null`);
    }
  }

  const invalidColumn = invalidDomainColumn(table, data);
  if (invalidColumn) {
    throw new BackupRecordError(`备份数据损坏：${table} 第 ${rowNumber} 行的 ${invalidColumn} 字段不是有效的领域 JSON`);
  }
}

function safeSqliteInteger(value: unknown, context: string): unknown {
  if (typeof value !== "bigint") return value;
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BackupRecordError(`备份字段无效：${context} 超出安全整数范围`);
  }
  return Number(value);
}

function encodeRecord(record: BackupRecord): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  assertBackupRecordBytes(encoded.byteLength);
  return encoded;
}

/**
 * 扫描上传目录，得到要写进容器的头像文件清单。
 *
 * 只列清单不读内容：这里在事务外、也可能在用户点下导出后很久才被消费，
 * 提前把几 MB 的照片读进内存既无必要，也会让「导出期间文件被换掉」的窗口更大。
 * 真正的字节在流里逐个读，并当场核对长度。
 */
function readUploadManifest(database: DatabaseSync): BackupFileEntry[] {
  const referenced = listReferencedUploadFilenames(database);
  const names = listUploadFilenames().filter((name) => referenced.has(name));
  if (names.length > MAX_BACKUP_FILES) {
    throw new BackupRecordError(`头像文件数量超过限制：${names.length} > ${MAX_BACKUP_FILES}`);
  }
  return names.map((name) => {
    const bytes = uploadFileSize(name);
    if (bytes > MAX_BACKUP_FILE_BYTES) {
      throw new BackupRecordError(`头像文件超过限制：${name} 为 ${bytes} 字节`);
    }
    return { name, bytes, chunks: Math.max(1, Math.ceil(bytes / BACKUP_FILE_CHUNK_BYTES)) };
  });
}

export function createBackupRecordStream(
  database: DatabaseSync,
  now = new Date(),
  options: BackupRecordOptions = {},
): AsyncIterable<Buffer> {
  const versionRow = database.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const dbVersion = versionRow?.user_version;
  if (!Number.isSafeInteger(dbVersion) || dbVersion !== CURRENT_DB_VERSION) {
    throw new BackupRecordError(`数据库版本无效：${String(dbVersion)}`);
  }

  validateDatabaseSchema(database);
  const tableStatements = new Map<string, {
    first: ReturnType<DatabaseSync["prepare"]>;
    next: ReturnType<DatabaseSync["prepare"]>;
  }>();
  for (const table of TABLES_CLEAR_ORDER) {
    const first = database.prepare(
      `SELECT rowid AS __backup_cursor__, * FROM "${table}" ORDER BY rowid LIMIT 200`,
    );
    const next = database.prepare(
      `SELECT rowid AS __backup_cursor__, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT 200`,
    );
    first.setReadBigInts(true);
    next.setReadBigInts(true);
    tableStatements.set(table, { first, next });
  }

  return (async function* stream(): AsyncIterable<Buffer> {
    let transactionOpen = false;
    let complete = false;
    let primaryError: unknown;
    let plaintextBytes = 0;
    let totalRows = 0;

    function append(record: BackupRecord): Buffer {
      const encoded = encodeRecord(record);
      assertBackupPlaintextBytes(plaintextBytes + encoded.byteLength);
      plaintextBytes += encoded.byteLength;
      return encoded;
    }

    try {
      database.exec("BEGIN");
      transactionOpen = true;
      database.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
      validateResumeVersionRelations(database);
      const files = readUploadManifest(database);
      const fileNames = new Set(files.map((file) => file.name));

      const createdAt = now.toISOString();
      assertStringBytes(createdAt);
      let sequences: BackupSequences;
      try {
        sequences = readBackupSequences(database);
      } catch (error) {
        throw new BackupRecordError("数据库自增序列无效：必须是安全整数且属于已知表", { cause: error });
      }
      const manifest: ManifestRecord = {
        kind: "manifest",
        appName: "resume-life",
        backupVersion: BACKUP_CONTAINER_VERSION,
        dbVersion,
        createdAt,
        tables: TABLES_CLEAR_ORDER,
        sequences,
        files,
      };
      yield append(manifest);

      const stats: Record<string, number> = {};
      for (const table of TABLES_CLEAR_ORDER) {
        let cursor: number | undefined;
        let tableRows = 0;
        const { first: firstStatement, next: nextStatement } = tableStatements.get(table)!;

        for (;;) {
          const batch = (cursor === undefined ? firstStatement.all() : nextStatement.all(cursor)) as
            Array<Record<string, unknown> & { __backup_cursor__: unknown }>;
          if (batch.length === 0) break;

          for (const rawRow of batch) {
            const rawCursor = safeSqliteInteger(rawRow.__backup_cursor__, `${table} rowid`);
            if (!Number.isSafeInteger(rawCursor) || (cursor !== undefined && (rawCursor as number) <= cursor)) {
              throw new BackupRecordError(`备份游标无效：${table}`);
            }
            const data: Record<string, unknown> = {};
            for (const [column, value] of Object.entries(rawRow)) {
              if (column !== "__backup_cursor__") {
                const sensitiveSetting = table === "settings" && (column === "api_key" || column === "proxy_password");
                const safeValue = safeSqliteInteger(value, `${table} 第 ${tableRows + 1} 行 ${column}`);
                // 凭证密文绑定当前设备密钥，用户备份只保留普通设置。
                data[column] = sensitiveSetting && options.includeSensitiveSettings === false
                  ? ""
                  : safeValue;
              }
            }
            const nextTableRows = tableRows + 1;
            const nextTotalRows = totalRows + 1;
            assertBackupTableRows(nextTableRows);
            assertBackupTotalRows(nextTotalRows);
            assertRowValues(table, nextTableRows, data);
            const avatarContents = table === "resume_modules" && data.type === "basic" && typeof data.content === "string"
              ? [data.content]
              : table === "resume_versions" && typeof data.snapshot === "string"
                ? (JSON.parse(data.snapshot) as ResumeSnapshot).modules.filter((item) => item.type === "basic").map((item) => JSON.stringify(item.content))
                : [];
            for (const content of avatarContents) {
              const avatar = avatarUrlFromContent(content);
              if (avatar.startsWith(UPLOAD_URL_PREFIX)) {
                const avatarPath = uploadPathFromUrl(avatar);
                if (!avatarPath || !fileNames.has(path.basename(avatarPath))) {
                  throw new BackupRecordError("备份数据库头像引用未包含在文件清单中");
                }
              }
            }

            yield append({ kind: "row", table, data });
            cursor = rawCursor as number;
            tableRows = nextTableRows;
            totalRows = nextTotalRows;
          }

          if (batch.length < BACKUP_BATCH_SIZE) break;
        }

        stats[table] = tableRows;
      }

      // 头像文件放在全部业务行之后、end 之前：恢复端按记录顺序流式写盘，
      // 放在这里保证「数据行先落地、文件随后补齐」，中途失败时不会留下指向空文件的行。
      let writtenFiles = 0;
      for (const entry of files) {
        const bytes = readUploadBytes(entry.name);
        // 清单是按目录扫描得出的，与随后逐个读盘之间隔着若干次 yield；
        // 文件在这期间被换掉（换头像 = 写新删旧）就会读出与清单不符的长度，
        // 而 end.files 只校验个数，长度不符会一路走到恢复端才暴露。
        if (bytes.byteLength !== entry.bytes) {
          throw new BackupRecordError(`头像文件在导出期间发生变化：${entry.name}`);
        }
        for (let index = 0; index < entry.chunks; index += 1) {
          const start = index * BACKUP_FILE_CHUNK_BYTES;
          yield append({
            kind: "file",
            name: entry.name,
            index,
            data: bytes.subarray(start, start + BACKUP_FILE_CHUNK_BYTES).toString("base64"),
          });
        }
        writtenFiles += 1;
      }

      yield append({ kind: "end", stats, totalRecords: totalRows, files: writtenFiles });
      complete = true;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (transactionOpen) {
        const operation = complete ? "COMMIT" : "ROLLBACK";
        try {
          database.exec(operation);
        } catch (cleanupError) {
          if (primaryError === undefined) throw cleanupError;
          reportCleanupFailure(primaryError, operation, "source-database", cleanupError);
        }
      }
    }
  })();
}

export function createOwnedBackupRecordStream(
  database: DatabaseSync,
  now = new Date(),
  options: BackupRecordOptions = {},
): AsyncIterable<Buffer> {
  let closed = false;
  const close = (primaryError?: unknown): void => {
    if (closed) return;
    try {
      database.close();
      closed = true;
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      reportCleanupFailure(primaryError, "close", "source-database", cleanupError);
    }
  };

  let iterator: AsyncIterator<Buffer>;
  try {
    iterator = createBackupRecordStream(database, now, options)[Symbol.asyncIterator]();
  } catch (error) {
    close(error);
    throw error;
  }

  const ownedIterator: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      try {
        const result = await iterator.next();
        if (result.done) close();
        return result;
      } catch (error) {
        close(error);
        throw error;
      }
    },
    async return() {
      let primaryError: unknown;
      try {
        return iterator.return
          ? await iterator.return()
          : { done: true as const, value: undefined };
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        close(primaryError);
      }
    },
  };

  return ownedIterator;
}
