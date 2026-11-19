export const BACKUP_MEDIA_TYPE = "application/vnd.resume-life.backup";
export const BACKUP_EXTENSION = ".rlbackup";
export const VALIDATION_DEBOUNCE_MS = 350;

export type BackupManifest = {
  kind: "manifest";
  appName: "resume-life";
  backupVersion: string;
  dbVersion: number;
  createdAt: string;
  tables: string[];
};

export type BackupValidation = {
  manifest: BackupManifest;
  stats: Record<string, number>;
  totalRecords: number;
};

export type Feedback = {
  kind: "progress" | "ok" | "err";
  text: string;
  snapshotCreated?: string;
};

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** 校验面板必须完整来自同一次服务端读取，不将缺失计数补成零。 */
export function readBackupValidation(value: unknown): BackupValidation {
  const invalid = () => new Error("备份校验响应不完整，请重新验证文件");
  if (!record(value) || value.ok !== true || !record(value.manifest) || !record(value.stats) || !count(value.totalRecords)) throw invalid();
  const manifest = value.manifest;
  if (manifest.kind !== "manifest" || manifest.appName !== "resume-life" || manifest.backupVersion !== "1.0.0" ||
      !Number.isSafeInteger(manifest.dbVersion) || (manifest.dbVersion as number) < 1 || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(manifest.tables) || !manifest.tables.every(table => typeof table === "string" && table.length > 0) || new Set(manifest.tables).size !== manifest.tables.length) throw invalid();
  const stats = value.stats;
  if (Object.keys(stats).length !== manifest.tables.length || !manifest.tables.every(table => Object.hasOwn(stats, table) && count(stats[table])) ||
      Object.values(stats).reduce<number>((sum, item) => sum + (item as number), 0) !== value.totalRecords) throw invalid();
  return { manifest: manifest as BackupManifest, stats: stats as Record<string, number>, totalRecords: value.totalRecords };
}

/** 完成确认包含原包逐表计数及恢复前灾备位置；并非可跨页查询的请求回执。 */
export function readBackupRestoreConfirmation(value: unknown, expected: BackupValidation): string {
  if (!record(value) || value.ok !== true || !record(value.stats) || typeof value.snapshotCreated !== "string" || !value.snapshotCreated.trim() ||
      Object.keys(value.stats).length !== Object.keys(expected.stats).length ||
      !Object.entries(expected.stats).every(([table, total]) => (value.stats as Record<string, unknown>)[table] === total)) {
    throw new Error("恢复响应不完整或与已验证的备份不符");
  }
  return value.snapshotCreated;
}

export function passwordError(password: string): string | null {
  let codePoints = 0;
  for (let index = 0; index < password.length; index += 1) {
    const codeUnit = password.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = password.charCodeAt(index + 1);
      if (index + 1 >= password.length || next < 0xdc00 || next > 0xdfff) {
        return "备份密码包含无效的 Unicode 字符";
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return "备份密码包含无效的 Unicode 字符";
    }
    codePoints += 1;
  }
  return codePoints >= 12 && codePoints <= 256
    ? null
    : "备份密码长度必须为 12 到 256 个 Unicode code point";
}

export function encodePasswordHeader(password: string): string {
  const bytes = new TextEncoder().encode(password);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function backupFilename(disposition: string | null): string {
  const fallback = `resume-life-backup${BACKUP_EXTENSION}`;
  if (!disposition) return fallback;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/iu)?.[1];
  let filename = encoded ?? plain;
  if (!filename) return fallback;
  try {
    filename = decodeURIComponent(filename.trim());
  } catch {
    return fallback;
  }
  return filename.toLowerCase().endsWith(BACKUP_EXTENSION) ? filename : fallback;
}

export function isCompatibleBackup(file: File): boolean {
  if (file.name.toLowerCase().endsWith(".json")) return false;
  return file.name.toLowerCase().endsWith(BACKUP_EXTENSION) || file.type === BACKUP_MEDIA_TYPE;
}

export function tableCount(stats: Record<string, number>, table: string): number {
  const value = stats[table];
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
