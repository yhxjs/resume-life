import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { restoreAllData } from "@/lib/backup";
import {
  BackupAuthenticationError,
  BackupContainerFormatError,
  decodeBackupPasswordHeader,
  decryptBackupStream,
} from "@/lib/backup-container";
import { BackupLimitError } from "@/lib/backup-limits";
import { createEncryptedUploadSession } from "@/lib/backup-request";
import { BackupStagingError, stageBackupRecordStream, type StagedBackup } from "@/lib/backup-staging";
import { getDb } from "@/lib/db";
import { logCleanupFailure, logServerError, requestIdFrom } from "@/lib/server-errors";
import { createBackupOperation, backupOperationErrorResponse, type BackupOperation } from "@/lib/backup-operation";

const NO_STORE = "no-store, no-cache, must-revalidate";

function jsonResponse(body: unknown, status: number): Response {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": NO_STORE },
  });
}

/** 默认保留本机 AI 配置。 */
function parsePreserveAiConfig(value: string | null): boolean {
  if (value === null || value === "true") return true;
  if (value === "false") return false;
  throw new BackupContainerFormatError("保留 AI 配置请求头必须为 true 或 false");
}

function cleanupMessage(error: unknown): string {
  if (error instanceof Error) return "Error";
  if (error === null) return "null";
  return typeof error;
}

function reportDisposeFailure(primaryError: unknown, cleanupError: unknown, requestId?: string): void {
  const failure = {
    operation: "dispose",
    target: "staged-backup",
    message: cleanupMessage(cleanupError),
  };
  if (primaryError instanceof Error) {
    try {
      const error = primaryError as Error & { cleanupFailures?: typeof failure[] };
      if (error.cleanupFailures) error.cleanupFailures.push(failure);
      else Object.defineProperty(error, "cleanupFailures", { configurable: true, enumerable: false, value: [failure] });
    } catch {
      // Cleanup reporting must not replace the primary request error.
    }
  }
  try {
    logCleanupFailure({ requestId, error: cleanupError, context: { operation: "dispose", resource: "staged-backup" } });
  } catch {
    // Logging failure must not replace the primary request error.
  }
}

function isInputError(error: unknown): error is Error {
  return error instanceof BackupContainerFormatError ||
    error instanceof BackupAuthenticationError ||
    (error instanceof BackupStagingError && !error.message.startsWith("源数据库"));
}

async function handlePost(request: Request) {
  let operation: BackupOperation | undefined;
  try {
    operation = createBackupOperation(request);
    const upload = createEncryptedUploadSession(request, { signal: operation.signal, onProgress: operation.activity });
    let staged: StagedBackup | undefined;
    let restoreCommitted = false;
    let primaryError: unknown;
    try {
      const password = decodeBackupPasswordHeader(
        request.headers.get("X-Resume-Life-Backup-Password"),
      );
      const preserveAiConfig = parsePreserveAiConfig(
        request.headers.get("X-Resume-Life-Preserve-Ai-Config"),
      );
      staged = await stageBackupRecordStream(
        decryptBackupStream(password, upload.source),
        getDb(),
        operation.retryCleanup,
      );
      operation.check();
      const result = restoreAllData(staged, preserveAiConfig, operation.check);
      restoreCommitted = true;
      return jsonResponse({
        ok: true,
        stats: result.stats,
        snapshotCreated: result.snapshotCreated,
      }, 200);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      let finishPrimaryError = primaryError;
      if (finishPrimaryError === undefined && restoreCommitted) {
        finishPrimaryError = new Error("恢复已提交");
      }
      try {
        if (staged) {
          try {
            staged.dispose();
          } catch (cleanupError) {
            const pending = staged;
            operation.retryCleanup(() => pending.dispose());
            if (primaryError !== undefined) {
              reportDisposeFailure(primaryError, cleanupError, requestIdFrom(request));
            } else if (restoreCommitted) {
              reportDisposeFailure(finishPrimaryError, cleanupError, requestIdFrom(request));
            } else {
              finishPrimaryError = cleanupError;
              throw cleanupError;
            }
          }
        }
      } finally {
        await upload.finish(finishPrimaryError);
      }
    }
  } catch (error) {
    const operationResponse = backupOperationErrorResponse(error);
    if (operationResponse) return operationResponse;
    if (error instanceof BackupLimitError) {
      return jsonResponse({ ok: false, error: error.message }, 413);
    }
    if (isInputError(error)) {
      return jsonResponse({ ok: false, error: error.message }, 400);
    }
    const requestId = logServerError("backup.restore", error, {
      status: 500,
    });
    return jsonResponse({
      ok: false,
      error: "恢复失败，原数据未被替换，请根据关联 ID 排查",
      requestId,
    }, 500);
  } finally {
    operation?.dispose();
  }
}

export const POST = withRouteErrorHandling("POST /api/backup/restore", handlePost, { allowDataRestore: true });
