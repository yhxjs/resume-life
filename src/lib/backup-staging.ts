import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { TABLES_CLEAR_ORDER } from "@/lib/backup";
import { validateResumeVersionRelations } from "./backup-domain";
import { CURRENT_DB_VERSION, validateDatabaseSchema } from "@/lib/db";
import {
  BACKUP_FILE_CHUNK_BYTES,
  BackupLimitError,
  MAX_BACKUP_FIELD_BYTES,
  assertBackupPlaintextBytes,
  assertBackupRecordBytes,
  assertBackupTableRows,
  assertBackupTotalRows,
} from "@/lib/backup-limits";
import {
  type BackupFileEntry,
  type BackupRecord,
  type EndRecord,
  type ManifestRecord,
} from "@/lib/backup-records";
import {
  STAGED_FILES_DIRECTORY,
  cleanupStaleRestoreDirectories,
  copySchemas,
  createRestoreTemporaryDirectory,
  createStagedBackup,
  quoteIdentifier,
  removeTemporaryDirectory,
  reportCleanupFailure,
  type StagedBackup,
} from "@/lib/backup-staging-storage";
import {
  BackupStagingError,
  hasExactKeys,
  isRecord,
  isSafeFilename,
  validateEnd,
  validateManifest,
  validateRowData,
} from "@/lib/backup-staging-validation";

export { BackupStagingError } from "@/lib/backup-staging-validation";
export type { StagedBackup } from "@/lib/backup-staging-storage";

export async function stageBackupRecordStream(
  source: AsyncIterable<Uint8Array>,
  sourceDatabase: DatabaseSync,
  retryCleanup?: (cleanup: () => void) => void,
): Promise<StagedBackup> {
  validateDatabaseSchema(sourceDatabase);
  cleanupStaleRestoreDirectories();
  const temporaryDirectory = createRestoreTemporaryDirectory();
  let stagingDatabase: DatabaseSync | undefined;
  let transactionOpen = false;

  const rowCounts: Record<string, number> = Object.fromEntries(TABLES_CLEAR_ORDER.map((table) => [table, 0]));
  let totalRows = 0;
  let plaintextBytes = 0;
  let manifest: ManifestRecord | undefined;
  let end: EndRecord | undefined;
  let processingError: unknown;
  const lineBuffer = Buffer.allocUnsafe(MAX_BACKUP_FIELD_BYTES);
  let pendingBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  /**
   * 已落盘的头像文件状态。
   *
   * 按分块直接定位写入而不是先在内存里拼装：清单允许 1 万个文件、单个 5 MiB，
   * 攒齐再写等于给恢复流程留了 50 GiB 的内存出口，而容器本身早就有 4 GiB 明文上限。
   * 按 offset 写还顺带容忍了分块乱序——顺序本不该乱，但乱序不该让一个合法备份恢复失败。
   */
  type StagedFileState = {
    entry: BackupFileEntry;
    received: number;
    indices: Set<number>;
    handle: number | undefined;
  };
  const stagedFiles = new Map<string, StagedFileState>();
  let stagedFilesDirectoryCreated = false;

  function stagedFilePath(name: string): string {
    return path.join(temporaryDirectory, STAGED_FILES_DIRECTORY, name);
  }

  /**
   * 关闭全部写句柄。声明在 try 之外：catch 分支也要用它，
   * 而 Windows 上未关闭的句柄会让暂存目录删不掉，删除失败又会被当成清理错误盖过主错误。
   */
  function closeStagedFileHandles(): void {
    let failure: unknown;
    for (const state of stagedFiles.values()) {
      if (state.handle === undefined) continue;
      try {
        fs.closeSync(state.handle);
        state.handle = undefined;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  /**
   * 校验一个 file 记录并落盘。
   *
   * 名字必须先在 manifest.files 里登记过：否则就能借 name 里的相对路径
   * 往暂存目录之外写文件，而暂存目录随后会被整体删除——等于一个可控的删除原语。
   */
  function validateFileChunk(
    value: Record<string, unknown>,
    entries: readonly BackupFileEntry[],
  ): { record: BackupRecord; apply: () => void } {
    if (!hasExactKeys(value, ["kind", "name", "index", "data"]) ||
        typeof value.name !== "string" || !isSafeFilename(value.name) || typeof value.data !== "string") {
      throw new BackupStagingError("备份 file 记录无效");
    }
    const entry = entries.find((candidate) => candidate.name === value.name);
    if (!entry) throw new BackupStagingError(`备份 file 记录引用了未登记的文件：${value.name}`);
    const index = value.index;
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= entry.chunks) {
      throw new BackupStagingError(`备份 file 记录的分块序号无效：${value.name}`);
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(value.data, "base64");
    } catch (error) {
      throw new BackupStagingError(`备份 file 记录不是有效的 base64：${value.name}`, { cause: error });
    }
    // 只认规范 base64：Buffer.from 对非法字符是静默丢弃，不比对就会让「内容被截断」
    // 伪装成一次成功恢复，用户拿回一张损坏的图片却没有任何提示。
    if (bytes.toString("base64") !== value.data) {
      throw new BackupStagingError(`备份 file 记录不是规范的 base64：${value.name}`);
    }
    const isLastChunk = (index as number) === entry.chunks - 1;
    const expectedBytes = isLastChunk
      ? entry.bytes - (index as number) * BACKUP_FILE_CHUNK_BYTES
      : BACKUP_FILE_CHUNK_BYTES;
    if (bytes.byteLength !== expectedBytes) {
      throw new BackupStagingError(`备份 file 记录的分块长度与清单不符：${value.name}`);
    }

    const state = stagedFiles.get(entry.name) ?? {
      entry,
      received: 0,
      indices: new Set<number>(),
      handle: undefined,
    };
    if (state.indices.has(index as number)) {
      throw new BackupStagingError(`备份 file 记录的分块重复：${entry.name}`);
    }

    return {
      record: { kind: "file", name: entry.name, index: index as number, data: value.data },
      apply: () => {
        if (!stagedFilesDirectoryCreated) {
          const filesDirectory = path.join(temporaryDirectory, STAGED_FILES_DIRECTORY);
          fs.mkdirSync(filesDirectory, { recursive: true, mode: 0o700 });
          if (process.platform !== "win32") fs.chmodSync(filesDirectory, 0o700);
          stagedFilesDirectoryCreated = true;
        }
        if (state.handle === undefined) {
          state.handle = fs.openSync(stagedFilePath(entry.name), "w", 0o600);
          // 先登记所有权，首次写入 ENOSPC/EIO 时清理路径也能关闭句柄。
          stagedFiles.set(entry.name, state);
        }
        fs.writeSync(state.handle, bytes, 0, bytes.byteLength, (index as number) * BACKUP_FILE_CHUNK_BYTES);
        state.indices.add(index as number);
        state.received += bytes.byteLength;
      },
    };
  }

  try {
    stagingDatabase = new DatabaseSync(path.join(temporaryDirectory, "staging.db"));
    if (process.platform !== "win32") fs.chmodSync(path.join(temporaryDirectory, "staging.db"), 0o600);
    stagingDatabase.exec("PRAGMA foreign_keys = OFF");
    // 建表与导入共用事务，避免每张表独立提交在 Windows 上反复同步磁盘。
    // 先登记事务状态，复制表结构或准备语句失败时也能统一回滚。
    stagingDatabase.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    const tables = [...TABLES_CLEAR_ORDER];
    const allowedTables = new Set<string>(tables);
    const columnsByTable = copySchemas(sourceDatabase, stagingDatabase);
    const insertByTable = new Map<string, ReturnType<DatabaseSync["prepare"]>>(tables.map((table) => {
      const columns = columnsByTable.get(table);
      if (!columns) throw new BackupStagingError(`源数据库缺少列结构：${table}`);
      const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns.map((column) => quoteIdentifier(column.name)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
      return [table, stagingDatabase!.prepare(sql)] as const;
    }));

    function validateValue(value: unknown): { record: BackupRecord; apply: () => void } {
      if (!isRecord(value) || typeof value.kind !== "string") {
        throw new BackupStagingError("备份记录必须是带 kind 的 JSON 对象");
      }
      if (!manifest) {
        if (value.kind !== "manifest") throw new BackupStagingError("manifest 必须是第一条记录");
        const nextManifest = validateManifest(value, tables);
        return {
          record: {
            kind: "manifest",
            appName: nextManifest.appName,
            backupVersion: nextManifest.backupVersion,
            dbVersion: nextManifest.dbVersion,
            createdAt: nextManifest.createdAt,
            tables: [...nextManifest.tables],
            sequences: { ...nextManifest.sequences },
            files: nextManifest.files.map((file) => ({ ...file })),
          },
          apply: () => {
            manifest = nextManifest;
          },
        };
      }
      if (value.kind === "manifest") throw new BackupStagingError("manifest 重复");
      if (end) throw new BackupStagingError("end 之后不允许其他记录");

      if (value.kind === "end") {
        const nextEnd = validateEnd(value, tables);
        return {
          record: {
            kind: "end",
            // validateEnd 已逐表校验过是非负安全整数
            stats: Object.fromEntries(tables.map((table) => [table, nextEnd.stats[table]!])),
            totalRecords: nextEnd.totalRecords,
            files: nextEnd.files,
          },
          apply: () => {
            end = nextEnd;
          },
        };
      }
      if (value.kind === "file") {
        const nextFile = validateFileChunk(value, manifest.files);
        return {
          record: nextFile.record,
          apply: nextFile.apply,
        };
      }
      if (value.kind !== "row" || !hasExactKeys(value, ["kind", "table", "data"]) || typeof value.table !== "string") {
        throw new BackupStagingError("备份 row 记录无效");
      }
      if (!allowedTables.has(value.table)) throw new BackupStagingError(`未知表：${value.table}`);

      const table = value.table;
      const nextTableRows = (rowCounts[table] ?? 0) + 1;
      const nextTotalRows = totalRows + 1;
      assertBackupTableRows(nextTableRows);
      assertBackupTotalRows(nextTotalRows);
      const columns = columnsByTable.get(table);
      const insert = insertByTable.get(table);
      if (!columns || !insert) throw new BackupStagingError(`未知表：${table}`);
      const data = validateRowData(table, nextTableRows, value.data, columns);
      const orderedData: Record<string, unknown> = Object.fromEntries(
        columns.map((column) => [column.name, data[column.name]]),
      );

      return {
        record: { kind: "row", table, data: orderedData },
        apply: () => {
          try {
            insert.run(...columns.map((column) => orderedData[column.name] as string | number | null));
          } catch (error) {
            const code = isRecord(error) ? error.code : undefined;
            if (typeof code === "string" && code.startsWith("ERR_SQLITE_CONSTRAINT")) {
              throw new BackupStagingError(`备份数据损坏：${table} 第 ${nextTableRows} 行违反数据库约束`, { cause: error });
            }
            throw error;
          }
          rowCounts[table] = nextTableRows;
          totalRows = nextTotalRows;
        },
      };
    }

    function processLine(lineBytes: number): void {
      assertBackupRecordBytes(lineBytes + 1);
      let text: string;
      try {
        text = decoder.decode(lineBuffer.subarray(0, lineBytes));
      } catch (error) {
        throw new BackupStagingError("备份记录包含非法 UTF-8", { cause: error });
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch (error) {
        throw new BackupStagingError("备份记录 JSON 无效", { cause: error });
      }
      const validated = validateValue(value);
      const canonical = Buffer.from(JSON.stringify(validated.record), "utf8");
      if (canonical.byteLength !== lineBytes || !canonical.equals(lineBuffer.subarray(0, lineBytes))) {
        throw new BackupStagingError("备份记录不是 canonical JSON");
      }
      validated.apply();
    }

    function processChunk(chunk: Uint8Array): void {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let start = 0;
      for (;;) {
        const newline = bytes.indexOf(0x0a, start);
        if (newline === -1) break;
        const lineBytes = pendingBytes + newline - start;
        assertBackupRecordBytes(lineBytes + 1);
        bytes.copy(lineBuffer, pendingBytes, start, newline);
        processLine(lineBytes);
        pendingBytes = 0;
        start = newline + 1;
      }
      if (start < bytes.byteLength) {
        const remainingBytes = bytes.byteLength - start;
        assertBackupRecordBytes(pendingBytes + remainingBytes);
        bytes.copy(lineBuffer, pendingBytes, start);
        pendingBytes += remainingBytes;
      }
    }

    let sourceError: unknown;
    let limitError: unknown;
    try {
      for await (const chunk of source) {
        if (limitError === undefined) {
          try {
            const nextPlaintextBytes = plaintextBytes + chunk.byteLength;
            assertBackupPlaintextBytes(nextPlaintextBytes);
            plaintextBytes = nextPlaintextBytes;
          } catch (error) {
            if (error instanceof BackupLimitError) {
              limitError = error;
            } else if (processingError === undefined) {
              processingError = error;
            }
          }
        }
        if (processingError !== undefined || limitError !== undefined) continue;
        try {
          processChunk(chunk);
        } catch (error) {
          if (error instanceof BackupLimitError) {
            limitError = error;
          } else {
            processingError = error;
          }
        }
      }
    } catch (error) {
      sourceError = error;
    }

    if (sourceError !== undefined) throw sourceError;
    if (limitError !== undefined) throw limitError;
    if (processingError !== undefined) throw processingError;
    // 先把写句柄关掉再继续：Windows 上未关闭的句柄会让暂存目录删不掉，
    // 而删除失败又会被当成清理错误盖过真正的主错误。
    closeStagedFileHandles();
    if (pendingBytes > 0) throw new BackupStagingError("备份流存在未以换行结束的截断尾行");
    if (!manifest) throw new BackupStagingError("备份流缺少 manifest");
    if (!end) throw new BackupStagingError("备份流缺少 end");
    if (manifest.dbVersion !== CURRENT_DB_VERSION) {
      throw new BackupStagingError(`备份数据库版本不匹配：${manifest.dbVersion} !== ${CURRENT_DB_VERSION}`);
    }
    if (end.totalRecords !== totalRows || tables.some((table) => end!.stats[table] !== rowCounts[table])) {
      throw new BackupStagingError("备份统计与实际行数不匹配");
    }

    // 清单里的每个文件都必须收齐全部分块，且长度与清单一致。
    // 少一个分块时文件仍然存在、只是尾部缺失——不校验就会把一张截断的照片恢复回去。
    for (const entry of manifest.files) {
      const state = stagedFiles.get(entry.name);
      if (!state || state.received !== entry.bytes || state.indices.size !== entry.chunks) {
        throw new BackupStagingError(`备份头像文件不完整：${entry.name}`);
      }
    }
    if (end.files !== stagedFiles.size) {
      throw new BackupStagingError("备份头像文件数与统计不匹配");
    }

    for (const [table, sequence] of Object.entries(manifest.sequences)) {
      const maxRow = stagingDatabase.prepare(`SELECT MAX(id) AS maxId FROM ${quoteIdentifier(table)}`).get() as
        { maxId: number | null } | undefined;
      if (typeof maxRow?.maxId === "number" && maxRow.maxId > sequence) {
        throw new BackupStagingError(`备份序列无效：${table} 低于备份中的最大 ID`);
      }
    }

    const foreignKeyError = stagingDatabase.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyError !== undefined) throw new BackupStagingError("备份数据损坏：外键完整性校验失败");
    validateResumeVersionRelations(stagingDatabase);
    const integrityRow = stagingDatabase.prepare("PRAGMA integrity_check(1)").get() as { integrity_check?: unknown } | undefined;
    if (integrityRow?.integrity_check !== "ok") {
      throw new BackupStagingError("备份数据损坏：SQLite 完整性校验失败");
    }
    stagingDatabase.exec("COMMIT");
    transactionOpen = false;
    stagingDatabase.exec("PRAGMA foreign_keys = ON");

    const result = createStagedBackup(stagingDatabase, temporaryDirectory, manifest, end, allowedTables);
    stagingDatabase = undefined;
    // 句柄已全部关闭（上面关过一轮），这里再调一次是为了让后续任何分支都不会漏关
    return result;
  } catch (primaryError) {
    let cleanupPending = false;
    let directoryRemoved = false;
    try {
      closeStagedFileHandles();
    } catch (cleanupError) {
      cleanupPending = true;
      reportCleanupFailure(primaryError, "close", temporaryDirectory, cleanupError);
    }
    if (transactionOpen && stagingDatabase) {
      try {
        stagingDatabase.exec("ROLLBACK");
      } catch (cleanupError) {
        reportCleanupFailure(primaryError, "ROLLBACK", temporaryDirectory, cleanupError);
      }
      transactionOpen = false;
    }
    if (stagingDatabase) {
      try {
        stagingDatabase.close();
        stagingDatabase = undefined;
      } catch (cleanupError) {
        cleanupPending = true;
        reportCleanupFailure(primaryError, "close", temporaryDirectory, cleanupError);
      }
    }
    try {
      removeTemporaryDirectory(temporaryDirectory);
      directoryRemoved = true;
    } catch (cleanupError) {
      cleanupPending = true;
      reportCleanupFailure(primaryError, "removeTemporaryDirectory", temporaryDirectory, cleanupError);
    }
    if (cleanupPending) {
      retryCleanup?.(() => {
        closeStagedFileHandles();
        if (stagingDatabase) {
          stagingDatabase.close();
          stagingDatabase = undefined;
        }
        if (!directoryRemoved) {
          removeTemporaryDirectory(temporaryDirectory);
          directoryRemoved = true;
        }
      });
    }
    throw primaryError;
  }
}
