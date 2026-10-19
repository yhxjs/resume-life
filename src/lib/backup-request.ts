import { logCleanupFailure } from "@/lib/server-errors";
import { BackupContainerFormatError } from "@/lib/backup-container";
import { assertEncryptedBackupBytes } from "@/lib/backup-limits";

export const MAX_EXPORT_REQUEST_BYTES = 4 * 1024;

export class BackupRequestBodyError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415) {
    super(message);
    this.name = "BackupRequestBodyError";
    this.status = status;
  }
}

type CleanupFailure = {
  operation: string;
  target: string;
  message: string;
};

type ErrorWithCleanupFailures = Error & {
  cleanupFailures?: CleanupFailure[];
};

function cleanupErrorMessage(error: unknown): string {
  if (error instanceof Error) return "Error";
  if (error === null) return "null";
  return typeof error;
}

function reportCleanupFailure(primaryError: unknown, operation: string, cleanupError: unknown): void {
  const failure: CleanupFailure = {
    operation,
    target: "request-body",
    message: cleanupErrorMessage(cleanupError),
  };
  if (primaryError instanceof Error) {
    try {
      const error = primaryError as ErrorWithCleanupFailures;
      if (error.cleanupFailures) error.cleanupFailures.push(failure);
      else Object.defineProperty(error, "cleanupFailures", {
        configurable: true,
        enumerable: false,
        value: [failure],
      });
    } catch {
      // Cleanup reporting must not replace the primary request error.
    }
  }
  try {
    logCleanupFailure({ error: cleanupError, context: { operation, resource: "request-body" } });
  } catch {
    // Logging failure must not replace the primary request error.
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  primaryError?: unknown,
): Promise<void> {
  try {
    await reader.cancel();
  } catch (cleanupError) {
    reportCleanupFailure(primaryError, "cancel", cleanupError);
    if (primaryError === undefined) throw cleanupError;
  }
}

function releaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  primaryError?: unknown,
): void {
  try {
    reader.releaseLock();
  } catch (cleanupError) {
    reportCleanupFailure(primaryError, "releaseLock", cleanupError);
    if (primaryError === undefined) throw cleanupError;
  }
}

type BackupReadOptions = { signal?: AbortSignal; onProgress?: () => void };

export async function readExportRequestJson(request: Request, options: BackupReadOptions = {}): Promise<unknown> {
  const contentType = request.headers.get("Content-Type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    const error = new BackupRequestBodyError("导出请求 Content-Type 必须为 application/json", 415);
    if (request.body) {
      const reader = request.body.getReader();
      try {
        await cancelReader(reader, error);
      } finally {
        releaseReader(reader, error);
      }
    }
    throw error;
  }
  if (!request.body) throw new BackupRequestBodyError("导出请求必须是合法 JSON", 400);

  const reader = request.body.getReader();
  const signal = options.signal ?? request.signal;
  let cancellation: Promise<void> | undefined;
  const cancel = (error?: unknown) => cancellation ??= cancelReader(reader, error);
  const onAbort = () => { void cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let naturalEof = false;
  let primaryError: unknown;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        naturalEof = true;
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new BackupRequestBodyError("导出请求体格式无效", 400);
      }
      totalBytes += value.byteLength;
      if (value.byteLength > 0) options.onProgress?.();
      if (totalBytes > MAX_EXPORT_REQUEST_BYTES) {
        throw new BackupRequestBodyError("导出请求体超过 4KiB 限制", 413);
      }
      chunks.push(value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    } catch {
      throw new BackupRequestBodyError("导出请求必须是合法 JSON", 400);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (!naturalEof) await cancel(primaryError);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      releaseReader(reader, primaryError);
    }
  }
}

export type EncryptedUploadSession = {
  source: AsyncIterable<Uint8Array>;
  finish(primaryError?: unknown): Promise<void>;
};

export function createEncryptedUploadSession(request: Request, options: BackupReadOptions = {}): EncryptedUploadSession {
  if (!request.body) throw new BackupContainerFormatError("未接收到加密备份数据");
  let totalBytes = 0;
  let naturalEof = false;
  const reader = request.body.getReader();
  const signal = options.signal ?? request.signal;
  let finishOperation: Promise<Array<{ operation: string; error: unknown }>> | undefined;
  let cleanupReported = false;

  async function settleFinish(primaryError: unknown, deferUnownedFailure: boolean): Promise<void> {
    finishOperation ??= (async () => {
      signal?.removeEventListener("abort", onAbort);
      const failures: Array<{ operation: string; error: unknown }> = [];
      if (!naturalEof) {
        try {
          await reader.cancel();
        } catch (error) {
          failures.push({ operation: "cancel", error });
        }
      }
      try {
        reader.releaseLock();
      } catch (error) {
        failures.push({ operation: "releaseLock", error });
      }
      return failures;
    })();

    const failures = await finishOperation;
    if (failures.length === 0) return;
    if (primaryError === undefined) {
      if (!deferUnownedFailure) throw failures[0]!.error;
      return;
    }
    if (!cleanupReported) {
      cleanupReported = true;
      for (const failure of failures) {
        reportCleanupFailure(primaryError, failure.operation, failure.error);
      }
    }
  }

  async function finish(primaryError?: unknown): Promise<void> {
    await settleFinish(primaryError, false);
  }

  function onAbort(): void {
    // reader.cancel 实际结束 pending read；清理失败由 settleFinish 关联记录。
    void settleFinish(signal?.reason, false).catch(() => {});
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const source = (async function* stream(): AsyncIterable<Uint8Array> {
    let primaryError: unknown;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        signal?.throwIfAborted();
        if (done) {
          naturalEof = true;
          break;
        }
        if (!(value instanceof Uint8Array)) {
          throw new BackupContainerFormatError("加密备份请求体格式无效");
        }
        totalBytes += value.byteLength;
        if (value.byteLength > 0) options.onProgress?.();
        assertEncryptedBackupBytes(totalBytes);
        yield value;
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await settleFinish(primaryError, true);
    }
  })();

  return { source, finish };
}
