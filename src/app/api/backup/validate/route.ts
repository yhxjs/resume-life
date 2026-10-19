import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
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
    let primaryError: unknown;
    try {
      const password = decodeBackupPasswordHeader(
        request.headers.get("X-Resume-Life-Backup-Password"),
      );
      staged = await stageBackupRecordStream(
        decryptBackupStream(password, upload.source),
        getDb(),
        operation.retryCleanup,
      );
      operation.check();
      return jsonResponse({
        ok: true,
        manifest: staged.manifest,
        stats: staged.stats,
        totalRecords: staged.totalRecords,
      }, 200);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      let finishPrimaryError = primaryError;
      try {
        if (staged) {
          try {
            staged.dispose();
          } catch (cleanupError) {
            const pending = staged;
            operation.retryCleanup(() => pending.dispose());
            if (primaryError === undefined) {
              finishPrimaryError = cleanupError;
              throw cleanupError;
            }
            reportDisposeFailure(primaryError, cleanupError, requestIdFrom(request));
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
    const requestId = logServerError("backup.validate", error, {
      status: 500,
    });
    return jsonResponse({
      ok: false,
      error: "无法校验备份，请检查数据库状态后重试",
      requestId,
    }, 500);
  } finally {
    operation?.dispose();
  }
}

export const POST = withRouteErrorHandling("POST /api/backup/validate", handlePost);
