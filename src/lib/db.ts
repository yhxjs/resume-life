import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { logServerEvent } from "@/lib/server-errors";
import { CURRENT_DB_VERSION, initializeDatabase, rollbackIgnoringAutoRollback, validateDatabaseSchema } from "./db-schema";
import { assertDataGeneration, trackDataGeneration } from "./data-generation";
import { recoverPendingRestoreFiles } from "./backup-restore-files";

export { CURRENT_DB_VERSION, initializeDatabase, validateDatabaseSchema };

export const DATA_DIR = process.env.RESUME_LIFE_DATA_DIR
  ? path.resolve(process.env.RESUME_LIFE_DATA_DIR)
  : path.join(process.cwd(), "data");

/**
 * 显式配置的数据目录在模块加载期做一次只读校验。
 *
 * 校验两件能确定性判定的事：
 * - 必须是绝对路径。相对路径的解析基准是 process.cwd()，同一份配置换个启动方式
 *   就换了库，而 TROUBLESHOOTING 给的示例本来就是绝对路径。
 * - 最近的已存在祖先必须是目录且可写。指向一个只读挂载点或一个同名文件时，
 *   这里就能拦下，而不是等到第一次写库才报错。
 *
 * 刻意不要求目标目录「已存在」：指向一个尚未创建的目录是首次部署的正当用法
 * （测试夹具也大量这么用），强制要求存在会把正常用法一并拒掉。
 * 因此目录不存在时只记一条 warn 提示它将被创建——打错的路径至少留下一条可搜索的痕迹。
 *
 * 只 stat / access，不创建任何东西：构建期追踪检查依赖「启动不碰数据目录」这一约定。
 */
function assertConfiguredDataDirectory(rawValue: string, directory: string): void {
  const fail = (resource: string): never => {
    logServerEvent("warn", "db.dataDir", { context: { resource } });
    process.exit(1);
  };

  if (!path.isAbsolute(rawValue)) return fail("relative-data-directory");

  if (!fs.existsSync(directory)) {
    logServerEvent("warn", "db.dataDir", { context: { resource: "data-directory-will-be-created" } });
  }

  let existing = directory;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return fail("unreachable-data-directory");
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) return fail("data-directory-parent-not-directory");
  try {
    fs.accessSync(existing, fs.constants.W_OK);
  } catch {
    return fail("readonly-data-directory");
  }
}

if (process.env.RESUME_LIFE_DATA_DIR) {
  assertConfiguredDataDirectory(process.env.RESUME_LIFE_DATA_DIR, DATA_DIR);
}

const DB_PATH = path.join(DATA_DIR, "resume-life.db");

let db: DatabaseSync | null = null;

function tightenPrivateDirectory(directory: string): void {
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function tightenPrivateFile(file: string): void {
  if (process.platform !== "win32" && fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

function tightenPrivateDataChildren(): void {
  if (process.platform === "win32") return;
  for (const name of ["uploads", "backups"]) {
    const directory = path.join(DATA_DIR, name);
    try {
      const stats = fs.lstatSync(directory);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile()) fs.chmodSync(path.join(directory, entry.name), 0o600);
      }
    } catch {
      // 可选目录可能尚未创建；首次写入路径会再次应用权限。
    }
  }
}

let dataDirectoryNoticePrinted = false;

/**
 * 数据目录未显式配置时由 process.cwd() 决定，从非预期目录启动会安静地新建一个空库。
 * 这里提示目录配置状态，并在新建库时明确提示，避免用户误以为数据丢失；不记录完整路径。
 */
function announceDataDirectory(opened: DatabaseSync, isNewDatabase: boolean): void {
  if (dataDirectoryNoticePrinted) return;
  dataDirectoryNoticePrinted = true;
  const configured = Boolean(process.env.RESUME_LIFE_DATA_DIR);
  if (isNewDatabase) {
    console.warn(
      "[db] 新建数据库" +
        (configured ? "" : "（RESUME_LIFE_DATA_DIR 未设置，数据目录取自当前工作目录）")
    );
  } else if (!configured) {
    console.warn("[db] RESUME_LIFE_DATA_DIR 未设置，使用当前工作目录下的数据目录");
  }
  // 结构化摘要只带排障所需的事实，不记录数据库路径，避免把本机目录结构写进日志。
  const journal = opened.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
  const version = opened.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  logServerEvent("info", "db.open", {
    context: {
      resource: isNewDatabase ? "new-database" : "existing-database",
      dataDirConfigured: configured,
      journalMode: typeof journal?.journal_mode === "string" ? journal.journal_mode : "unknown",
      dbVersion: typeof version?.user_version === "number" ? version.user_version : 0,
    },
  });
}

export function getDb(): DatabaseSync {
  if (db) {
    trackDataGeneration(db);
    return db;
  }
  if (process.env.NODE_ENV === "test" && !process.env.RESUME_LIFE_DATA_DIR) {
    throw new Error("测试进程必须显式设置 RESUME_LIFE_DATA_DIR 数据目录");
  }
  const isNewDatabase = !fs.existsSync(DB_PATH);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  tightenPrivateDirectory(DATA_DIR);
  tightenPrivateDataChildren();
  const opened = new DatabaseSync(DB_PATH);
  try {
    // 初始化会申请写锁，等待策略必须先于争锁操作。
    opened.exec("PRAGMA busy_timeout = 5000");
    tightenPrivateFile(DB_PATH);
    initializeDatabase(opened);
    opened.exec("PRAGMA journal_mode = WAL");
    opened.exec("PRAGMA foreign_keys = ON");
    // WAL 在不支持的文件系统（如网络盘）上不会报错、只会静默保持旧 journal 模式；
    // 读回校验并显式留痕，避免「直到 health 长红才发现」。
    const activeJournalMode =
      opened.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown } | undefined;
    if (activeJournalMode?.journal_mode !== "wal") {
      logServerEvent("warn", "db.journalMode", { context: { resource: "wal-not-active" } });
    }
    tightenPrivateFile(DB_PATH);
    tightenPrivateFile(`${DB_PATH}-wal`);
    tightenPrivateFile(`${DB_PATH}-shm`);
    recoverPendingRestoreFiles(opened, path.join(DATA_DIR, "uploads"));
    db = opened;
    announceDataDirectory(opened, isNewDatabase);
  } catch (error) {
    opened.close();
    throw error;
  }
  trackDataGeneration(db);
  return db;
}

/**
 * 健康检查用：验证数据目录可写、磁盘未满、数据库文件可写。
 * 只做文件级探测，不触碰业务数据，也不申请写锁（避免与长事务互斥）。
 */
export function assertStorageWritable(): void {
  const probePath = path.join(DATA_DIR, ".health-write-probe");
  try {
    fs.writeFileSync(probePath, String(Date.now()));
  } finally {
    fs.rmSync(probePath, { force: true });
  }
  fs.accessSync(DB_PATH, fs.constants.W_OK);
}

export function openReadOnlyDatabase(): DatabaseSync {
  getDb();
  const opened = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    opened.exec("PRAGMA query_only = ON");
    return opened;
  } catch (error) {
    opened.close();
    throw error;
  }
}

let txDepth = 0;

const commandState = globalThis as typeof globalThis & { resumeLifeCommands?: Set<string> };
const activeCommands = commandState.resumeLifeCommands ??= new Set<string>();

/** 同进程重复命令在模型调用前拒绝；跨进程一致性仍由提交事务和条件写入保证。 */
export function acquireCommandLock(key: string): (() => void) | null {
  if (activeCommands.has(key)) return null;
  activeCommands.add(key);
  return () => { activeCommands.delete(key); };
}

/** 把多条写语句包进同一事务：任一步失败整体回滚，避免留下中间态；支持安全嵌套 */
export function inTransaction<T>(fn: () => T): T {
  const database = getDb();
  const isOuter = txDepth === 0;
  if (isOuter) {
    // IMMEDIATE 而非 deferred：事务内「先读后写」需要把共享锁升级为写锁，
    // deferred 下若另一进程在两次读之间提交，升级会立刻得到 SQLITE_BUSY_SNAPSHOT
    // 且不受 busy_timeout 调解。项目其余写路径（initializeDatabase、restoreAllData）
    // 都已用 IMMEDIATE，这里保持一致。
    database.exec("BEGIN IMMEDIATE");
  }
  txDepth++;
  try {
    assertDataGeneration();
    const result = fn();
    if (isOuter) {
      assertDataGeneration();
      database.exec("COMMIT");
    }
    return result;
  } catch (err) {
    if (isOuter) {
      rollbackIgnoringAutoRollback(database, err);
    }
    throw err;
  } finally {
    txDepth--;
  }
}

export function now(): string {
  return new Date().toISOString();
}

/** 恢复事务会更换此标记；跨进程请求也能识别旧数据库世代。 */
export function dataGeneration(database: DatabaseSync = getDb()): string | null {
  const row = database.prepare("SELECT data_generation FROM runtime_state WHERE id = 1").get() as
    { data_generation: string } | undefined;
  return row?.data_generation ?? null;
}

/** handler 等待请求体前冻结世代；尚无数据库时记录初始空世代，不创建运行数据。 */
export function requestDataGeneration(): string | null {
  if (process.env.NODE_ENV === "test" && !process.env.RESUME_LIFE_DATA_DIR) return null;
  return db || fs.existsSync(DB_PATH) ? dataGeneration(getDb()) : null;
}

/** 转义 LIKE 通配符（配合 SQL 里的 ESCAPE '\' 使用），避免用户输入的 % _ 被当成通配符 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
