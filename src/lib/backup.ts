import { logCleanupFailure } from "@/lib/server-errors";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { UPLOADS_DIR, listReferencedUploadFilenames, uploadPathFromUrl } from "@/lib/upload-storage";
import { createPreRestoreSnapshot, discardFailedPreRestoreSnapshot, rotatePreRestoreSnapshots, type CreatedPreRestoreSnapshot } from "./backup-snapshot";
import { cleanupErrorMessage } from "./backup-cleanup-error";
import { stageRestoreFiles, prepareRestoreFiles, promoteRestoreFiles, rollbackRestoreFiles, recoverRestoreFiles, recoverPendingRestoreFiles, type RestoreFiles } from "./backup-restore-files";

export { MAX_PRE_RESTORE_SNAPSHOTS, MIN_SNAPSHOT_BUDGET_BYTES, SNAPSHOT_DATABASE_MULTIPLIER } from "./backup-snapshot";


/** 按依赖关系自底向上清空表（从依赖子表到独立主表） */
export const TABLES_CLEAR_ORDER = [
  "application_interview_recap_exports",
  "application_interview_recaps",
  "application_interview_questions",
  "review_attempts",
  "review_cards",
  "application_preparation_resources",
  "application_preparation_tasks",
  "llm_call_logs",
  "resume_defense_drills",
  "resume_defenses",
  "resignation_gap_remedies",
  "application_interviews",
  "application_stage_history",
  "applications",
  "salary_negotiation_turns",
  "salary_negotiations",
  "jargon_decodings",
  "drill_questions",
  "drills",
  "interview_turns",
  "interviews",
  "interview_series",
  "intro_versions",
  "intros",
  "project_materials",
  "project_summary_history",
  "resume_modules",
  "resume_diagnoses",
  "notebook_entries",
  "notebook_categories",
  "resume_templates",
  "bank_entries",
  "projects",
  "resume_versions",
  "resumes",
  "jd_portraits",
  "settings",
] as const;

/** 逆序为插入顺序（从独立主表到依赖子表） */
export const TABLES_INSERT_ORDER = [...TABLES_CLEAR_ORDER].reverse();

/** 拥有 AUTOINCREMENT 自增主键的表清单 */
export const AUTOINCREMENT_TABLES = [
  "application_interview_recap_exports",
  "application_interview_recaps",
  "application_interview_questions",
  "review_attempts",
  "review_cards",
  "application_preparation_resources",
  "application_preparation_tasks",
  "resume_diagnoses",
  "resume_defense_drills",
  "resume_defenses",
  "resignation_gap_remedies",
  "application_interviews",
  "application_stage_history",
  "applications",
  "resumes",
  "resume_versions",
  "resume_modules",
  "projects",
  "project_materials",
  "project_summary_history",
  "drills",
  "drill_questions",
  "bank_entries",
  "interview_series",
  "interviews",
  "interview_turns",
  "intros",
  "intro_versions",
  "resume_templates",
  "notebook_categories",
  "notebook_entries",
  "jd_portraits",
  "jargon_decodings",
  "salary_negotiations",
  "salary_negotiation_turns",
  "llm_call_logs",
] as const;

export type BackupSequences = Partial<Record<(typeof AUTOINCREMENT_TABLES)[number], number>>;

function normalizeSequenceValue(value: unknown, table: string): number {
  if (typeof value === "bigint") {
    if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`备份序列无效：${table} 必须是非负安全整数`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`备份序列无效：${table} 必须是非负安全整数`);
  }
  return value as number;
}

export function readBackupSequences(database: DatabaseSync): BackupSequences {
  const sequences: BackupSequences = {};
  const sequenceTable = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'",
  ).get();
  if (!sequenceTable) return sequences;

  const statement = database.prepare("SELECT name, seq FROM sqlite_sequence");
  statement.setReadBigInts(true);
  const rows = statement.all() as Array<{
    name: unknown;
    seq: unknown;
  }>;
  const allowed = new Set<string>(AUTOINCREMENT_TABLES);
  for (const row of rows) {
    // 认证是机器运行时状态，序列与会话一样不进入业务备份。
    if (row.name === "auth_sessions") continue;
    if (typeof row.name !== "string" || !allowed.has(row.name)) {
      throw new Error(`数据库序列无效：${String(row.name)}`);
    }
    sequences[row.name as (typeof AUTOINCREMENT_TABLES)[number]] = normalizeSequenceValue(row.seq, row.name);
  }
  return sequences;
}

export function validateBackupSequences(value: unknown): BackupSequences {
  if (!isRecord(value)) throw new Error("备份序列无效");
  const allowed = new Set<string>(AUTOINCREMENT_TABLES);
  const sequences: BackupSequences = {};
  for (const [table, sequence] of Object.entries(value)) {
    if (!allowed.has(table)) throw new Error(`备份序列无效：未知表 ${table}`);
    sequences[table as (typeof AUTOINCREMENT_TABLES)[number]] = normalizeSequenceValue(sequence, table);
  }
  return sequences;
}

export interface DatabaseStats {
  resumes: number;
  projects: number;
  interviews: number;
  drills: number;
  bank_entries: number;
  notebook_entries: number;
  intros: number;
  templates: number;
  totalRecords: number;
  hasAiConfig: boolean;
  dbVersion: number;
}

/** 获取当前数据库各模块数据统计 */
export function getDatabaseStats(): DatabaseStats {
  const db = getDb();
  // 用一条语句的标量子查询一次取回全部表的计数，替代每张表一次 COUNT(*) 往返
  const row = db
    .prepare(
      `SELECT ${TABLES_CLEAR_ORDER.map((table) => `(SELECT COUNT(*) FROM ${table}) AS "${table}"`).join(", ")}`
    )
    .get() as Record<string, unknown> | undefined;
  function count(table: string): number {
    const value = row?.[table];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`数据库统计结果无效：${table}`);
    }
    return value;
  }

  const resumes = count("resumes");
  const projects = count("projects");
  const interviews = count("interviews");
  const drills = count("drills");
  const bank_entries = count("bank_entries");
  const notebook_entries = count("notebook_entries");
  const intros = count("intros");
  const templates = count("resume_templates");

  let totalRecords = 0;
  for (const table of TABLES_CLEAR_ORDER) {
    totalRecords += count(table);
  }

  const currentSettings = readSettings();
  const hasAiConfig = Boolean(currentSettings.api_key || currentSettings.base_url);

  const vRow = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const dbVersion = vRow?.user_version ?? 0;

  return {
    resumes,
    projects,
    interviews,
    drills,
    bank_entries,
    notebook_entries,
    intros,
    templates,
    totalRecords,
    hasAiConfig,
    dbVersion,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ValidatedBackupHandle = {
  readonly stats: Readonly<Record<string, number>>;
  readonly sequences: Readonly<BackupSequences>;
  /** 备份容器携带的头像文件清单。 */
  readonly files: readonly RestorableBackupFile[];
  readTableBatch(
    table: string,
    afterRowId?: number,
    limit?: number,
  ): Array<{ cursor: number; data: Record<string, unknown> }>;
  readFileBytes(name: string): Buffer;
};

/** 恢复侧看待备份容器里一个头像文件的方式：只需名字与字节 */
export type RestorableBackupFile = {
  readonly name: string;
  readonly bytes: number;
};

type CleanupFailure = {
  operation: string;
  target: string;
  message: string;
};

type ErrorWithCleanupFailures = Error & {
  cleanupFailures?: CleanupFailure[];
};

function reportRestoreCleanupFailure(
  primaryError: unknown,
  operation: string,
  cleanupError: unknown,
  target = "destination-database",
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
      // Cleanup reporting must not replace the primary restore error.
    }
  }
  try {
    logCleanupFailure({ error: cleanupError, context: { operation, resource: failure.target } });
  } catch {
    // Logging failure must not replace the primary restore error.
  }
}

function insertStagedRows(
  database: DatabaseSync,
  staged: ValidatedBackupHandle,
  preserveAiConfig: boolean,
): void {
  for (const table of TABLES_INSERT_ORDER) {
    if (table === "settings" && preserveAiConfig) continue;
    let cursor: number | undefined;
    let insert: ReturnType<DatabaseSync["prepare"]> | undefined;
    let columns: string[] | undefined;

    for (;;) {
      const batch = staged.readTableBatch(table, cursor, 200);
      if (batch.length === 0) break;
      for (const row of batch) {
        if (!columns) {
          columns = Object.keys(row.data);
          insert = database.prepare(
            `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          );
        }
        insert!.run(...columns.map((column) => row.data[column] as string | number | null));
      }
      cursor = batch.at(-1)!.cursor;
    }
  }
}

function versionRestoredAvatarUrls(database: DatabaseSync): void {
  const version = randomUUID();
  const rows = database.prepare("SELECT id, content FROM resume_modules WHERE type = 'basic'").all() as { id: number; content: string }[];
  const update = database.prepare("UPDATE resume_modules SET content = ? WHERE id = ?");
  for (const row of rows) {
    const content = JSON.parse(row.content) as Record<string, unknown>;
    const avatar = content.avatar;
    if (typeof avatar !== "string" || !uploadPathFromUrl(avatar)) continue;
    content.avatar = `${new URL(avatar, "http://localhost").pathname}?v=${version}`;
    update.run(JSON.stringify(content), row.id);
  }
}


/**
 * 从已完整认证并校验的隔离暂存句柄完全覆盖现有数据
 * @param staged 已验证的只读暂存句柄
 * @param preserveAiConfig 是否保留当前设备的 AI Key 与模型设置
 * @param checkDeadline 恢复前与提交前检查取消/截止时间，失败沿既有补偿路径回滚
 */
export function restoreAllData(
  staged: ValidatedBackupHandle,
  preserveAiConfig: boolean,
  checkDeadline?: () => void,
): { success: boolean; stats: Record<string, number>; snapshotCreated: string | null } {
  const db = getDb();
  checkDeadline?.();

  db.exec("PRAGMA foreign_keys = OFF");
  let snapshotCreated: string | null = null;
  let createdSnapshot: CreatedPreRestoreSnapshot | null = null;
  let restoreFiles: RestoreFiles | null = null;
  let transactionStarted = false;
  let committed = false;
  let filesReadyForCleanup = false;
  let primaryError: unknown;

  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    recoverRestoreFiles(db, UPLOADS_DIR);
    createdSnapshot = createPreRestoreSnapshot(true);
    snapshotCreated = createdSnapshot.path;
    restoreFiles = stageRestoreFiles(staged, UPLOADS_DIR);
    // 逆序清空所有数据表。
    for (const table of TABLES_CLEAR_ORDER) {
      if (table === "settings" && preserveAiConfig) {
        continue; // 保留当前配置时不清空 settings 表
      }
      db.prepare(`DELETE FROM ${table}`).run();
    }

    insertStagedRows(db, staged, preserveAiConfig);
    versionRestoredAvatarUrls(db);

    // 同步重置 SQLite AUTOINCREMENT 序列号。
    const seqTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
      .get();
    if (seqTable) {
      for (const table of AUTOINCREMENT_TABLES) {
        const maxRow = db.prepare(`SELECT MAX(id) as maxId FROM ${table}`).get() as
          | { maxId: number | null }
          | undefined;
        const source = table === "interview_turns" ? "interview" : table === "drill_questions" ? "drill" :
          table === "application_interview_recap_exports" ? "application_interview" : undefined;
        const sourceMax = source === undefined
          ? 0
          : ((db.prepare("SELECT MAX(source_id) AS maxSourceId FROM notebook_entries WHERE source = ?").get(source) as
            { maxSourceId: number | null } | undefined)?.maxSourceId ?? 0);
        const backupSequence = staged.sequences[table] ?? 0;
        const maxId = Math.max(
          backupSequence,
          typeof maxRow?.maxId === "number" ? maxRow.maxId : 0,
          typeof sourceMax === "number" ? sourceMax : 0,
        );
        if (maxId > 0) {
          db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, maxId);
        } else {
          db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
        }
      }
    }

    // 校验外键完整性。
    const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (fkErrors.length > 0) {
      throw new Error(`外键完整性校验失败：检测到 ${fkErrors.length} 处损坏的外键引用关系`);
    }

    // 提交事务
    const referenced = listReferencedUploadFilenames(db);
    prepareRestoreFiles(restoreFiles, referenced);
    promoteRestoreFiles(restoreFiles, referenced);
    db.prepare("INSERT INTO runtime_state (id, data_generation) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data_generation = excluded.data_generation")
      .run(restoreFiles.generation);
    checkDeadline?.();
    db.exec("COMMIT");
    committed = true;
    filesReadyForCleanup = true;
    transactionStarted = false;
  } catch (err) {
    primaryError = err;
    let rollbackComplete = true;
    try {
      if (restoreFiles) rollbackRestoreFiles(restoreFiles);
    } catch (cleanupError) {
      rollbackComplete = false;
      reportRestoreCleanupFailure(err, "restore avatar files", cleanupError);
    }
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch (cleanupError) {
        rollbackComplete = false;
        reportRestoreCleanupFailure(err, "ROLLBACK", cleanupError);
      }
    }
    filesReadyForCleanup = rollbackComplete;
    if (createdSnapshot && rollbackComplete) {
      try {
        discardFailedPreRestoreSnapshot(createdSnapshot);
      } catch (cleanupError) {
        reportRestoreCleanupFailure(err, "discard failed restore snapshot", cleanupError, "pre-restore-snapshot");
      }
    }
    throw err;
  } finally {
    try {
      if (restoreFiles && filesReadyForCleanup) recoverPendingRestoreFiles(db, UPLOADS_DIR);
    } catch (cleanupError) {
      reportRestoreCleanupFailure(primaryError, "cleanup staged avatar files", cleanupError);
    }
    try {
      db.exec("PRAGMA foreign_keys = ON");
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        reportRestoreCleanupFailure(primaryError, "PRAGMA foreign_keys = ON", cleanupError);
      } else if (committed) {
        reportRestoreCleanupFailure(undefined, "PRAGMA foreign_keys = ON", cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }

  rotatePreRestoreSnapshots(db, snapshotCreated!);

  return {
    success: true,
    stats: { ...staged.stats },
    snapshotCreated,
  };
}
