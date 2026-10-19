import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import {
  BACKUP_FILE_EXTENSION,
  BACKUP_MEDIA_TYPE,
  assertBackupPassword,
  createEncryptedBackupStream,
} from "@/lib/backup-container";
import { createOwnedBackupRecordStream } from "@/lib/backup-records";
import { BackupRequestBodyError, readExportRequestJson } from "@/lib/backup-request";
import { openReadOnlyDatabase } from "@/lib/db";
import { logServerError } from "@/lib/server-errors";
import { createBackupOperation, createBackupDownloadStream, backupOperationErrorResponse, type BackupOperation } from "@/lib/backup-operation";

const NO_STORE = "no-store, no-cache, must-revalidate";

function jsonResponse(body: unknown, status: number): Response {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": NO_STORE },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exportFilename(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  return `resume-life-backup-${timestamp}${BACKUP_FILE_EXTENSION}`;
}

async function handlePost(request: Request) {
  let operation: BackupOperation | undefined;
  let streamOwnsOperation = false;
  try {
    operation = createBackupOperation(request);
    let input: unknown;
    try {
      input = await readExportRequestJson(request, { signal: operation.signal, onProgress: operation.activity });
    } catch (error) {
      if (error instanceof BackupRequestBodyError) {
        return jsonResponse({ ok: false, error: error.message }, error.status);
      }
      throw error;
    }
    if (!isRecord(input)) {
      return jsonResponse({ ok: false, error: "导出请求格式无效" }, 400);
    }
    if (Object.keys(input).length !== 2 ||
        !Object.hasOwn(input, "password") ||
        !Object.hasOwn(input, "confirmation")) {
      return jsonResponse({ ok: false, error: "导出请求格式无效" }, 400);
    }

    const password = assertBackupPassword(input.password);
    const confirmation = assertBackupPassword(input.confirmation);
    if (password !== confirmation) {
      return jsonResponse({ ok: false, error: "两次输入的备份密码不一致" }, 400);
    }

    const now = new Date();
    operation.check();
    const plaintext = createOwnedBackupRecordStream(openReadOnlyDatabase(), now, { includeSensitiveSettings: false });
    const encrypted = createEncryptedBackupStream(password, plaintext, now);
    const filename = exportFilename(now);
    const response = new Response(createBackupDownloadStream(encrypted, operation,
      () => plaintext[Symbol.asyncIterator]().return?.()), {
      status: 200,
      headers: {
        "Content-Type": BACKUP_MEDIA_TYPE,
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": NO_STORE,
      },
    });
    streamOwnsOperation = true;
    return response;
  } catch (error) {
    const operationResponse = backupOperationErrorResponse(error);
    if (operationResponse) return operationResponse;
    if (error instanceof TypeError || error instanceof RangeError) {
      return jsonResponse({ ok: false, error: error.message }, 400);
    }
    const requestId = logServerError("backup.export", error, {
      status: 500,
    });
    return jsonResponse({
      ok: false,
      error: "导出数据失败，请检查数据库状态后重试",
      requestId,
    }, 500);
  } finally {
    if (!streamOwnsOperation) operation?.dispose();
  }
}

export const POST = withRouteErrorHandling("POST /api/backup/export", handlePost);
