import { describe, expect, it } from "vitest";
import { invalidDomainColumn } from "../backup-domain";
import { normalizeContent } from "../modules";
import { BACKUP_VERSION, TABLES_CLEAR_ORDER, validateBackupSequences } from "./backup-fixture";
import { BACKUP_CONTAINER_VERSION } from "../backup-records";
import { createEncryptedBackupStream } from "../backup-container";
import { validateEnd, validateManifest } from "../backup-staging-validation";

describe("首版备份契约", () => {
  it("内部载荷、manifest 和加密文件头均为首版", async () => {
    expect(BACKUP_VERSION).toBe("1.0.0");
    expect(BACKUP_CONTAINER_VERSION).toBe("1.0.0");
    const stream = createEncryptedBackupStream("synthetic-password", (async function* () { yield Buffer.from("test"); })());
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 7)).toEqual(Buffer.from([0x52, 0x4c, 0x49, 0x46, 0x45, 0x00, 0x01]));
    const length = bytes.readUInt32BE(7);
    expect(JSON.parse(bytes.subarray(11, 11 + length).toString()).version).toBe(1);
  });

  it("manifest 要求序列与头像清单，不接受缺失字段", () => {
    expect(() => validateBackupSequences(undefined)).toThrow(/序列/);
    const manifest = { kind: "manifest", appName: "resume-life", backupVersion: BACKUP_CONTAINER_VERSION, dbVersion: 1, createdAt: "2026-09-30T00:00:00.000Z", tables: TABLES_CLEAR_ORDER, sequences: {}, files: [] };
    expect(validateManifest(manifest, TABLES_CLEAR_ORDER)).toEqual(manifest);
    const end = { kind: "end", stats: Object.fromEntries(TABLES_CLEAR_ORDER.map(table => [table, 0])), totalRecords: 0, files: 0 };
    expect(validateEnd(end, TABLES_CLEAR_ORDER)).toEqual(end);
    const incompleteEnd: Record<string, unknown> = { ...end };
    delete incompleteEnd.files;
    expect(() => validateEnd(incompleteEnd, TABLES_CLEAR_ORDER)).toThrow();
    for (const field of ["sequences", "files"]) {
      const incomplete: Record<string, unknown> = { ...manifest };
      delete incomplete[field];
      expect(() => validateManifest(incomplete, TABLES_CLEAR_ORDER)).toThrow();
    }
  });
  it("已存储的条目要求完整当前字段，不接受仅 description 的备份", () => {
    for (const type of ["work", "projects", "custom"] as const) {
      const content = normalizeContent(type, [{ id: "item" }]);
      const row = { type, content: JSON.stringify(content) };
      expect(invalidDomainColumn("resume_modules", row)).toBeUndefined();
      const incomplete = structuredClone(content) as unknown as Record<string, unknown>[];
      delete incomplete[0]!.descriptionItems;
      expect(invalidDomainColumn("resume_modules", { ...row, content: JSON.stringify(incomplete) })).toBe("content");
    }
  });
});
