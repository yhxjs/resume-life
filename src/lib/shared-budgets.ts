import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./db";

const BUDGET_DATABASE_NAME = "process-budgets.db";
const AUTH_KIND = "auth-password";
const LLM_KIND = "llm";
const BACKUP_KIND = "backup";
const testBudgetState = globalThis as typeof globalThis & { resumeLifeTestBudgetDirectory?: string };

export type AuthPasswordCheck =
  | { kind: "acquired"; token: string }
  | { kind: "rate-limited"; retryAfter: number }
  | { kind: "busy"; retryAfter: number };

function budgetDatabasePath(): string {
  if (process.env.NODE_ENV === "test" && !process.env.RESUME_LIFE_DATA_DIR) {
    if (!testBudgetState.resumeLifeTestBudgetDirectory) {
      const temporaryRoot = os.tmpdir();
      const directory = fs.mkdtempSync(path.join(temporaryRoot, "resume-life-process-budgets-"));
      // 模块重新加载仍共用同一进程预算；退出时只清理本进程创建的私有目录。
      testBudgetState.resumeLifeTestBudgetDirectory = directory;
      process.once("exit", () => {
        if (path.dirname(directory) === temporaryRoot && path.basename(directory).startsWith("resume-life-process-budgets-")) {
          fs.rmSync(directory, { recursive: true, force: true });
        }
        delete testBudgetState.resumeLifeTestBudgetDirectory;
      });
    }
    return path.join(testBudgetState.resumeLifeTestBudgetDirectory, BUDGET_DATABASE_NAME);
  }
  return path.join(DATA_DIR, BUDGET_DATABASE_NAME);
}

function tightenDirectory(directory: string): void {
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function tightenFile(file: string): void {
  if (process.platform !== "win32" && fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

function openBudgetDatabase(): DatabaseSync {
  const file = budgetDatabasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  tightenDirectory(path.dirname(file));
  const database = new DatabaseSync(file);
  try {
    tightenFile(file);
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS budget_leases (
        token TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS budget_leases_expiry ON budget_leases(expires_at);
      CREATE TABLE IF NOT EXISTS auth_budget_window (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        started_at INTEGER NOT NULL,
        failures INTEGER NOT NULL
      );
    `);
    tightenFile(file);
    tightenFile(`${file}-wal`);
    tightenFile(`${file}-shm`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function withBudgetTransaction<T>(fn: (database: DatabaseSync, now: number) => T, clockNow?: number): T {
  const database = openBudgetDatabase();
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = clockNow ?? Date.now();
      database.prepare("DELETE FROM budget_leases WHERE expires_at <= ?").run(timestamp);
      const result = fn(database, timestamp);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve the original budget error */ }
      throw error;
    }
  } finally {
    database.close();
  }
}

export function acquireAuthPasswordCheck(options: {
  now?: number;
  windowMs: number;
  maxFailures: number;
  maxActive: number;
  leaseMs: number;
}): AuthPasswordCheck {
  return withBudgetTransaction((database, currentTime) => {
    const timestamp = options.now ?? currentTime;
    const window = database.prepare("SELECT started_at, failures FROM auth_budget_window WHERE id = 1").get() as
      { started_at: number; failures: number } | undefined;
    const windowExpired = !window || timestamp - window.started_at >= options.windowMs || timestamp < window.started_at;
    const startedAt = windowExpired ? timestamp : window.started_at;
    const failures = windowExpired ? 0 : window.failures;
    if (!window) {
      database.prepare("INSERT INTO auth_budget_window (id, started_at, failures) VALUES (1, ?, 0)").run(startedAt);
    } else if (windowExpired) {
      database.prepare("UPDATE auth_budget_window SET started_at = ?, failures = 0 WHERE id = 1").run(startedAt);
    }
    if (failures >= options.maxFailures) {
      return {
        kind: "rate-limited",
        retryAfter: Math.max(1, Math.ceil((startedAt + options.windowMs - timestamp) / 1000)),
      };
    }
    const active = database.prepare("SELECT COUNT(*) AS count FROM budget_leases WHERE kind = ?").get(AUTH_KIND) as { count: number };
    if (active.count >= options.maxActive) return { kind: "busy", retryAfter: 1 };
    const token = randomUUID();
    database.prepare("INSERT INTO auth_budget_window (id, started_at, failures) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET failures = excluded.failures").run(startedAt, failures + 1);
    database.prepare("INSERT INTO budget_leases (token, kind, expires_at) VALUES (?, ?, ?)").run(token, AUTH_KIND, timestamp + options.leaseMs);
    return { kind: "acquired", token };
  }, options.now);
}

export function completeAuthPasswordCheck(token: string, success: boolean): void {
  withBudgetTransaction((database) => {
    const result = database.prepare("DELETE FROM budget_leases WHERE token = ? AND kind = ?").run(token, AUTH_KIND);
    if (success && result.changes > 0) database.prepare("UPDATE auth_budget_window SET failures = 0 WHERE id = 1").run();
    return undefined;
  });
}

function acquireLease(kind: string, options: { now?: number; maxConcurrent: number; leaseMs: number }): string | null {
  return withBudgetTransaction((database, currentTime) => {
    const timestamp = options.now ?? currentTime;
    const active = database.prepare("SELECT COUNT(*) AS count FROM budget_leases WHERE kind = ?").get(kind) as { count: number };
    if (active.count >= options.maxConcurrent) return null;
    const token = randomUUID();
    database.prepare("INSERT INTO budget_leases (token, kind, expires_at) VALUES (?, ?, ?)").run(token, kind, timestamp + options.leaseMs);
    return token;
  }, options.now);
}

function releaseLease(kind: string, token: string): void {
  withBudgetTransaction((database) => {
    database.prepare("DELETE FROM budget_leases WHERE token = ? AND kind = ?").run(token, kind);
    return undefined;
  });
}

export function acquireLlmLease(options: { now?: number; maxConcurrent: number; leaseMs: number }): string | null {
  return acquireLease(LLM_KIND, options);
}

export function releaseLlmLease(token: string): void {
  releaseLease(LLM_KIND, token);
}

export function acquireBackupLease(options: { now?: number; maxConcurrent: number; leaseMs: number }): string | null {
  return acquireLease(BACKUP_KIND, options);
}

export function releaseBackupLease(token: string): void {
  releaseLease(BACKUP_KIND, token);
}

/** 清理仍持有资源时续租；进程退出后仍按有限租期回收。 */
export function renewBackupLease(token: string, options: { now?: number; leaseMs: number }): void {
  withBudgetTransaction((database, now) => {
    database.prepare("UPDATE budget_leases SET expires_at = ? WHERE token = ? AND kind = ?")
      .run(now + options.leaseMs, token, BACKUP_KIND);
  }, options.now);
}
