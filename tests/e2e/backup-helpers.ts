import type { APIRequestContext, APIResponse } from "@playwright/test";
import { Buffer } from "node:buffer";
import {
  BACKUP_MEDIA_TYPE,
  createEncryptedBackupStream,
  decryptBackupStream,
  encodeBackupPasswordHeader,
} from "../../src/lib/backup-container";
import type { BackupRecord } from "../../src/lib/backup-records";

export { BACKUP_MEDIA_TYPE, encodeBackupPasswordHeader };

export const E2E_BACKUP_PASSWORD = "E2E-backup-密码-2026";

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }
  return Buffer.concat(chunks);
}

async function* fromBuffer(value: Buffer): AsyncIterable<Buffer> {
  yield value;
}

export async function exportEncryptedBackup(
  request: APIRequestContext,
  password = E2E_BACKUP_PASSWORD,
): Promise<{ response: APIResponse; bytes: Buffer }> {
  const response = await request.post("/api/backup/export", {
    data: { password, confirmation: password },
  });
  return { response, bytes: await response.body() };
}

export async function postEncryptedBackup(
  request: APIRequestContext,
  endpoint: "/api/backup/validate" | "/api/backup/restore",
  bytes: Buffer,
  options: { password?: string; preserveAiConfig?: boolean } = {},
): Promise<APIResponse> {
  const password = options.password ?? E2E_BACKUP_PASSWORD;
  const headers: Record<string, string> = {
    "Content-Type": BACKUP_MEDIA_TYPE,
    "X-Resume-Life-Backup-Password": encodeBackupPasswordHeader(password),
  };
  if (endpoint === "/api/backup/restore") {
    headers["X-Resume-Life-Preserve-Ai-Config"] = String(options.preserveAiConfig ?? false);
  }
  return request.post(endpoint, { data: bytes, headers });
}

export async function rewriteEncryptedBackup(
  encrypted: Buffer,
  rewrite: (records: BackupRecord[]) => void,
  password = E2E_BACKUP_PASSWORD,
): Promise<Buffer> {
  const plaintext = await collect(decryptBackupStream(password, fromBuffer(encrypted)));
  const records = plaintext
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BackupRecord);
  rewrite(records);
  const rewritten = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return collect(createEncryptedBackupStream(password, fromBuffer(rewritten)));
}
