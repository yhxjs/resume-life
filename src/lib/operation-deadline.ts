import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

type Limits = { deadline?: number; signal?: AbortSignal; maxLockWaitMs?: number };
const limits = new AsyncLocalStorage<Limits>();

export class OperationTimeoutError extends Error {
  constructor() { super("操作超时，请稍后重试"); }
}

export function withOperationLimits<T>(value: Limits, fn: () => T): T {
  return limits.run(value, fn);
}

export function assertOperationActive(): void {
  const scope = limits.getStore();
  scope?.signal?.throwIfAborted();
  if (scope?.deadline !== undefined && performance.now() >= scope.deadline) throw new OperationTimeoutError();
}

export function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !("errcode" in error) || typeof error.errcode !== "number") return false;
  const primary = error.errcode & 0xff; // node:sqlite exposes the extended result code.
  return primary === 5 || primary === 6;
}

/** Budget only the synchronous slice: busy_timeout is per connection and must be restored before any await. */
export function withSqliteLockBudget<T>(db: DatabaseSync, fn: () => T): T {
  const scope = limits.getStore();
  if (!scope) return fn();
  assertOperationActive();
  const { timeout: previous } = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  const remaining = scope.deadline === undefined ? Infinity : Math.max(0, Math.ceil(scope.deadline - performance.now()));
  const waitMs = Math.min(previous, remaining, scope.maxLockWaitMs ?? Infinity);
  if (waitMs !== previous) db.exec(`PRAGMA busy_timeout = ${waitMs}`);
  try {
    return fn(); // Never report a timeout after a successful COMMIT.
  } catch (error) {
    if (isSqliteBusy(error)) assertOperationActive();
    throw error;
  } finally {
    if (waitMs !== previous) db.exec(`PRAGMA busy_timeout = ${previous}`);
  }
}

/** A request must not wait on auxiliary writes once its useful work is over. */
export function withoutWaitingForLock<T>(fn: () => T): T {
  return withOperationLimits({ maxLockWaitMs: 0 }, fn);
}

/** Allow cleanup/metering after cancellation without adding a fresh lock wait or bypassing restore checks. */
export function withCleanupLockBudget<T>(fn: () => T, maxWaitMs = Infinity): T {
  const scope = limits.getStore();
  if (!scope) return fn();
  const remaining = scope.signal?.aborted ? 0 : Math.max(0, Math.ceil((scope.deadline ?? Infinity) - performance.now()));
  return withOperationLimits({ maxLockWaitMs: Math.min(scope.maxLockWaitMs ?? Infinity, maxWaitMs, remaining) }, fn);
}
