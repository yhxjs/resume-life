import { acquireBackupLease, releaseBackupLease, renewBackupLease } from "./shared-budgets";
import { logCleanupFailure, logServerEvent } from "./server-errors";

export const BACKUP_IDLE_TIMEOUT_MS = 60_000;
export const BACKUP_TOTAL_TIMEOUT_MS = 30 * 60_000;

export class BackupOperationError extends Error {
  constructor(message: string, public readonly status: 408 | 429 | 499) {
    super(message);
    this.name = "BackupOperationError";
  }
}

export type BackupOperation = {
  signal: AbortSignal;
  activity(): void;
  check(): void;
  retryCleanup(cleanup: () => void | Promise<unknown>): void;
  dispose(): void;
};

/** 租约属于实际任务；上传清理完毕或下载生产器退出后才能 dispose。 */
export function createBackupOperation(request: Request): BackupOperation {
  if (request.signal?.aborted) throw new BackupOperationError("备份请求已取消", 499);
  const lease = acquireBackupLease({ maxConcurrent: 1, leaseMs: BACKUP_TOTAL_TIMEOUT_MS + 60_000 });
  if (!lease) {
    logServerEvent("warn", "backup.busy", { context: { resource: "backup" } });
    throw new BackupOperationError("已有备份任务正在执行，请完成或取消后重试", 429);
  }

  const controller = new AbortController();
  const deadline = Date.now() + BACKUP_TOTAL_TIMEOUT_MS;
  let idleDeadline = Date.now() + BACKUP_IDLE_TIMEOUT_MS;
  let disposed = false;
  let pendingCleanups = 0;
  let released = false;
  const releaseIfReady = () => {
    if (!disposed || pendingCleanups > 0 || released) return;
    released = true;
    try { releaseBackupLease(lease); }
    catch (error) { logCleanupFailure({ error, context: { operation: "release", resource: "backup-budget" } }); }
  };
  let idleTimer: ReturnType<typeof setTimeout>;
  const abort = (message: string, status: 408 | 499) => {
    if (disposed || controller.signal.aborted) return;
    controller.abort(new BackupOperationError(message, status));
    logServerEvent("warn", status === 408 ? "backup.timeout" : "backup.cancelled", { context: { resource: "backup" } });
  };
  const onRequestAbort = () => abort("备份请求已取消", 499);
  const onIdle = () => abort("备份任务超过 60 秒没有进展，已停止，请重试", 408);
  const onDeadline = () => abort("备份任务超过 30 分钟，已停止，请重试", 408);
  const totalTimer = setTimeout(onDeadline, BACKUP_TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleDeadline = Date.now() + BACKUP_IDLE_TIMEOUT_MS;
    idleTimer = setTimeout(onIdle, BACKUP_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  const check = () => {
    // 同步 SQLite/文件工作可能延迟 timer 回调；提交前也检查绝对时间。
    if (Date.now() >= deadline) onDeadline();
    else if (Date.now() >= idleDeadline) onIdle();
    controller.signal.throwIfAborted();
  };
  request.signal?.addEventListener("abort", onRequestAbort, { once: true });
  resetIdle();

  return {
    signal: controller.signal,
    check,
    activity() { check(); resetIdle(); },
    retryCleanup(cleanup) {
      // 调用方在 dispose 前移交失败清理；仅重试清理，不重放校验或恢复。
      pendingCleanups++;
      const schedule = () => {
        const timer = setTimeout(async () => {
          try { renewBackupLease(lease, { leaseMs: BACKUP_TOTAL_TIMEOUT_MS + 60_000 }); }
          catch (error) { logCleanupFailure({ error, context: { operation: "renew", resource: "backup-budget" } }); }
          try {
            await cleanup();
            pendingCleanups--;
            releaseIfReady();
          } catch {
            // 原失败已由请求/流记录；保留所有权直到资源确实释放。
            schedule();
          }
        }, 1_000);
        timer.unref?.();
      };
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      request.signal?.removeEventListener("abort", onRequestAbort);
      releaseIfReady();
    },
  };
}

export function backupOperationErrorResponse(error: unknown): Response | null {
  if (!(error instanceof BackupOperationError)) return null;
  return Response.json({ ok: false, error: error.message }, {
    status: error.status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...(error.status === 429 ? { "Retry-After": "1" } : {}),
    },
  });
}

/** 停止消费也必须主动退出生产器，释放读事务，不能只让 Promise.race 提前返回。 */
export function createBackupDownloadStream(
  source: AsyncIterable<Uint8Array>,
  operation: BackupOperation,
  closeOwnedSource?: () => void | Promise<unknown>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;
  let cleanup: Promise<void> | undefined;
  let onAbort: () => void;
  const close = async () => {
    try { await iterator.return?.(); }
    finally {
      // 加密生成器尚未开始时 return 不会执行其 finally，底层连接仍需显式关闭。
      await closeOwnedSource?.();
    }
  };
  const finish = () => cleanup ??= (async () => {
    operation.signal.removeEventListener("abort", onAbort);
    try { await close(); }
    catch (error) { operation.retryCleanup(close); throw error; }
    finally { operation.dispose(); }
  })();
  const logCleanup = (error: unknown) => logCleanupFailure({
    error, context: { operation: "close", resource: "backup-download" },
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (stopped) return;
        stopped = true;
        controller.error(operation.signal.reason);
        void finish().catch(logCleanup);
      };
      operation.signal.addEventListener("abort", onAbort, { once: true });
      if (operation.signal.aborted) onAbort();
    },
    async pull(controller) {
      if (stopped) return;
      try {
        operation.check();
        const next = await iterator.next();
        operation.check();
        if (stopped) return;
        if (next.done) {
          await finish();
          stopped = true;
          controller.close();
        } else {
          if (next.value.byteLength > 0) operation.activity();
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (!stopped) { stopped = true; controller.error(error); }
        await finish().catch(logCleanup);
      }
    },
    async cancel() {
      stopped = true;
      await finish();
    },
  });
}
