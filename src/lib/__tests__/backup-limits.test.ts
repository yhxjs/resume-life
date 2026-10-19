import { describe, expect, it } from "vitest";
import {
  assertBackupFieldBytes,
  assertBackupRecordBytes,
  BackupLimitError,
  MAX_BACKUP_FIELD_BYTES,
  MAX_BACKUP_RECORD_BYTES,
} from "../backup-limits";

describe("备份字节上限边界", () => {
  it("字段字节数恰好等于上限时通过，超一字节即拒绝", () => {
    expect(() => assertBackupFieldBytes(MAX_BACKUP_FIELD_BYTES)).not.toThrow();
    expect(() => assertBackupFieldBytes(MAX_BACKUP_FIELD_BYTES + 1)).toThrow(BackupLimitError);
  });

  it("单条记录字节数有独立上限，恰好等于上限时通过，超一字节即拒绝", () => {
    expect(() => assertBackupRecordBytes(MAX_BACKUP_RECORD_BYTES)).not.toThrow();
    expect(() => assertBackupRecordBytes(MAX_BACKUP_RECORD_BYTES + 1)).toThrow(BackupLimitError);
  });

  it("非安全整数与负数一律拒绝", () => {
    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertBackupRecordBytes(invalid)).toThrow(BackupLimitError);
    }
  });
});
