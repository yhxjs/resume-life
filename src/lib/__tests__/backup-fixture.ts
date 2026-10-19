import { DatabaseSync } from "node:sqlite";
import { CURRENT_DB_VERSION, getDb, inTransaction } from "../db";
import { invalidDomainColumn, validateResumeVersionRelations } from "../backup-domain";
import { AUTOINCREMENT_TABLES, TABLES_CLEAR_ORDER, TABLES_INSERT_ORDER, readBackupSequences, validateBackupSequences, type BackupSequences } from "../backup";
export * from "../backup";

export const BACKUP_APP_NAME = "resume-life";
export const BACKUP_VERSION = "1.0.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface BackupMetadata {
  appName: typeof BACKUP_APP_NAME;
  version: typeof BACKUP_VERSION;
  dbVersion: number;
  createdAt: string;
  stats: Record<string, number>;
  sequences: BackupSequences;
}

export type BackupPayload = {
  meta: BackupMetadata;
  data: Record<string, Record<string, unknown>[]>;
};

export function exportAllData(): BackupPayload {
  return inTransaction(() => {
    const db = getDb();
    const data: Record<string, Record<string, unknown>[]> = {};
    const stats: Record<string, number> = {};

    for (const table of TABLES_CLEAR_ORDER) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      data[table] = table === "settings"
        ? rows.map((row) => ({
          ...row,
          api_key: "",
          proxy_password: "",
        }))
        : rows;
      stats[table] = rows.length;
    }

    const vRow = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;

    return {
      meta: {
        appName: BACKUP_APP_NAME,
        version: BACKUP_VERSION,
        dbVersion: vRow?.user_version ?? 0,
        createdAt: new Date().toISOString(),
        stats,
        sequences: readBackupSequences(db),
      },
      data,
    };
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function insertRows(database: DatabaseSync, payload: BackupPayload, preserveAiConfig = false) {
  for (const table of TABLES_INSERT_ORDER) {
    if (table === "settings" && preserveAiConfig) continue;
    for (const row of payload.data[table] ?? []) {
      const keys = Object.keys(row);
      database.prepare(`INSERT INTO ${table} (${keys.map((key) => `"${key}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
        .run(...keys.map((key) => row[key] as string | number | null));
    }
  }
}

export function validateBackupPayload(input: unknown): { valid: true; payload: BackupPayload } | { valid: false; error: string } {
  if (!isRecord(input)) {
    return { valid: false, error: "备份文件格式无效：非合法 JSON 对象" };
  }
  const meta = input.meta;
  if (!isRecord(meta) || meta.appName !== BACKUP_APP_NAME) {
    return { valid: false, error: "无效的备份文件：非本系统导出的备份数据 (appName 不匹配)" };
  }
  if (!isRecord(input.data)) {
    return { valid: false, error: "备份数据损坏：缺少 data 数据主体" };
  }
  if (meta.version !== BACKUP_VERSION || meta.dbVersion !== CURRENT_DB_VERSION) {
    return { valid: false, error: `不支持此备份版本：仅接受格式 ${BACKUP_VERSION}、数据库版本 ${CURRENT_DB_VERSION} 的完整备份` };
  }
  const metadataKeysValid = hasExactKeys(meta, ["appName", "version", "dbVersion", "createdAt", "stats", "sequences"]);
  if (!metadataKeysValid || typeof meta.createdAt !== "string" || !Number.isFinite(Date.parse(meta.createdAt)) ||
      !isRecord(meta.stats) || !hasExactKeys(meta.stats, TABLES_CLEAR_ORDER) || !hasExactKeys(input.data, TABLES_CLEAR_ORDER)) {
    return { valid: false, error: "备份数据损坏：导出时间、完整表清单或统计信息无效" };
  }
  let sequences: BackupSequences;
  try {
    sequences = validateBackupSequences(meta.sequences);
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : "备份序列无效" };
  }
  const database = getDb();
  for (const table of TABLES_CLEAR_ORDER) {
    const rows = input.data[table];
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number }[];
    if (!columns.length || !Array.isArray(rows) || meta.stats[table] !== rows.length) {
      return { valid: false, error: `备份数据损坏：${table} 的结构或记录数量不匹配` };
    }
    for (const [index, row] of rows.entries()) {
      if (!isRecord(row) || !hasExactKeys(row, columns.map((column) => column.name)) || columns.some((column) => {
        const value = row[column.name];
        if (value === null) return Boolean(column.notnull || column.pk);
        return column.type === "INTEGER" ? !Number.isSafeInteger(value) : typeof value !== "string";
      })) return { valid: false, error: `备份数据损坏：${table} 含无效行、列或字段类型` };
      const invalidColumn = invalidDomainColumn(table, row);
      if (invalidColumn) {
        return { valid: false, error: `备份数据损坏：${table} 第 ${index + 1} 行（id=${row.id ?? row.resume_id}）的 ${invalidColumn} 字段不是有效的领域 JSON` };
      }
    }
    const sequence = sequences[table as (typeof AUTOINCREMENT_TABLES)[number]];
    if (sequence !== undefined) {
      const maxId = rows.reduce((max, row) => {
        const id = row.id;
        return typeof id === "number" && id > max ? id : max;
      }, 0);
      if (sequence < maxId) {
        return { valid: false, error: `备份序列无效：${table} 低于备份中的最大 ID` };
      }
    }
  }
  // 上方已逐表校验列集合、字段类型、领域 JSON 与外键完整性，此处窄化是安全的
  const payload = input as BackupPayload;
  // 在隔离内存库校验 CHECK、主键、唯一键和外键；失败不触碰现库。
  const validationDb = new DatabaseSync(":memory:");
  try {
    // 简历草稿引用来源版本，版本又引用简历；全部插入后统一校验循环引用。
    validationDb.exec("PRAGMA foreign_keys = OFF");
    for (const table of TABLES_INSERT_ORDER) {
      const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
      validationDb.exec(schema.sql);
    }
    insertRows(validationDb, payload);
    if (validationDb.prepare("PRAGMA foreign_key_check").all().length) throw new Error("外键引用无效");
    validateResumeVersionRelations(validationDb);
  } catch {
    return { valid: false, error: "备份数据损坏：记录违反数据库约束或外键完整性" };
  } finally {
    validationDb.close();
  }
  return {
    valid: true,
    payload: { ...payload, meta: { ...payload.meta, sequences } },
  };
}
