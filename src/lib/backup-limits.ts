export const BACKUP_BATCH_SIZE = 200;
export const MAX_ENCRYPTED_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_BACKUP_PLAINTEXT_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_BACKUP_FIELD_BYTES = 2 * 1024 * 1024;
// 单条记录 = 该行各字段之和，外加列名与 JSON 结构开销。当前取值与字段上限相同，
// 但语义独立：将来单独调整字段上限或记录上限时，两者不会互相牵连。
export const MAX_BACKUP_RECORD_BYTES = MAX_BACKUP_FIELD_BYTES;
export const MAX_BACKUP_ROWS_PER_TABLE = 1_000_000;
export const MAX_BACKUP_TOTAL_ROWS = 2_000_000;
/**
 * 头像文件在容器里的分块大小（原始字节）。
 *
 * 必须分块而不是整文件一条记录：暂存端解析用的行缓冲就是 MAX_BACKUP_FIELD_BYTES，
 * 一条超过 2 MiB 的记录根本进不了缓冲区。1 MiB 原始字节 base64 后约 1.33 MiB，
 * 加上 JSON 结构仍在单条记录上限内，也留得住余量。
 */
export const BACKUP_FILE_CHUNK_BYTES = 1024 * 1024;
/** 单个头像文件上限，与 /api/upload 的头像体积上限一致 */
export const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;
/** 单个文件最多分成几块；用于在解析端拦住 `chunks` 被伪造成天文数字 */
export const MAX_BACKUP_FILE_CHUNKS = Math.ceil(MAX_BACKUP_FILE_BYTES / BACKUP_FILE_CHUNK_BYTES);
export const MAX_BACKUP_FILES = 10_000;

export class BackupLimitError extends Error {
  readonly actual: number;
  readonly limit: number;

  constructor(label: string, actual: number, limit: number) {
    super(`备份${label}超过限制：${actual} > ${limit}`);
    this.name = "BackupLimitError";
    this.actual = actual;
    this.limit = limit;
  }
}

function assertLimit(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new BackupLimitError(label, value, maximum);
  }
}

export function assertEncryptedBackupBytes(value: number): void {
  assertLimit(value, MAX_ENCRYPTED_BACKUP_BYTES, "加密容器字节数");
}

export function assertBackupPlaintextBytes(value: number): void {
  assertLimit(value, MAX_BACKUP_PLAINTEXT_BYTES, "明文字节数");
}

export function assertBackupFieldBytes(value: number): void {
  assertLimit(value, MAX_BACKUP_FIELD_BYTES, "字段字节数");
}

export function assertBackupRecordBytes(value: number): void {
  assertLimit(value, MAX_BACKUP_RECORD_BYTES, "单条记录字节数");
}

export function assertBackupTableRows(value: number): void {
  assertLimit(value, MAX_BACKUP_ROWS_PER_TABLE, "单表行数");
}

export function assertBackupTotalRows(value: number): void {
  assertLimit(value, MAX_BACKUP_TOTAL_ROWS, "总行数");
}
