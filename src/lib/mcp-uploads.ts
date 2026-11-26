import { createHash } from "node:crypto";
import path from "node:path";
import { dataGeneration, getDb, inTransaction, now } from "./db";
import { mcpCreateOnce } from "./mcp-state";
import { assertMcpCacheCapacity, assertMcpCacheFresh, mcpCachePolicy } from "./mcp-cache";
import { McpOperationError } from "./mcp-errors";
import { MAX_UPLOAD_FILE_BYTES } from "./request-limits";

export const MCP_UPLOAD_CHUNK_BYTES = 48 * 1024;
export type UploadPurpose = "resume" | "project" | "avatar";
type Upload = { upload_id: string; generation: string; purpose: UploadPurpose; filename: string; byte_length: number; sha256: string;
  received_bytes: number; status: "uploading" | "complete"; created_at: string };
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function load(uploadId: string, requireFresh = true): Upload {
  const row = getDb().prepare("SELECT * FROM mcp_uploads WHERE upload_id=?").get(uploadId) as Upload | undefined;
  if (!row) throw new McpOperationError("NOT_FOUND", "上传记录不存在");
  if (requireFresh) {
    if (row.generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "数据已恢复，请以新幂等键重新上传");
    assertMcpCacheFresh(row.created_at);
  }
  return row;
}
function descriptor(row: Upload) {
  const status = row.generation !== (dataGeneration() ?? "initial") ? "invalidated"
    : Date.parse(row.created_at) + mcpCachePolicy().ttlHours * 3_600_000 <= Date.now() ? "expired" : row.status;
  return { uploadId: row.upload_id, purpose: row.purpose, filename: row.filename, byteLength: row.byte_length, sha256: row.sha256,
    receivedBytes: row.received_bytes, status, maxChunkBytes: MCP_UPLOAD_CHUNK_BYTES, createdAt: row.created_at };
}
export function beginMcpUpload(input: { filename: string; purpose: UploadPurpose; byteLength: number; sha256: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  if (!input.filename || input.filename.length > 200 || /[/\\\x00-\x1f:<>"|?*]/.test(input.filename) || input.filename.trim() !== input.filename ||
    !/^\.[a-z]+$/.test(path.extname(input.filename).toLowerCase())) throw new McpOperationError("INVALID_ARGUMENT", "上传名称须为带扩展名的文件名，不能包含路径或控制字符");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > (input.purpose === "avatar" ? 5 * 1024 * 1024 : MAX_UPLOAD_FILE_BYTES) ||
    !/^[a-f0-9]{64}$/.test(input.sha256)) throw new McpOperationError("INVALID_ARGUMENT", "上传大小或 SHA-256 无效");
  const ext = path.extname(input.filename).toLowerCase();
  const extensions = input.purpose === "avatar" ? [".png", ".jpg", ".jpeg", ".webp"] : [".txt", ".md", ".markdown", ".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp", ".bmp"];
  if (!extensions.includes(ext)) throw new McpOperationError("INVALID_ARGUMENT", "不支持的上传文件类型");
  const uploadId = digest(JSON.stringify(["begin_mcp_upload", idempotencyKey]));
  return inTransaction(() => {
    mcpCreateOnce("begin_mcp_upload", idempotencyKey, payload, () => {
      assertMcpCacheCapacity(512);
      getDb().prepare("INSERT INTO mcp_uploads(upload_id,generation,purpose,filename,byte_length,sha256,status,created_at) VALUES(?,?,?,?,?,?,'uploading',?)")
        .run(uploadId, dataGeneration() ?? "initial", input.purpose, input.filename, input.byteLength, input.sha256, now());
      return { id: Number.parseInt(uploadId.slice(0, 13), 16) || 1 };
    }, () => !!getDb().prepare("SELECT 1 FROM mcp_uploads WHERE upload_id=?").get(uploadId));
    return descriptor(load(uploadId));
  });
}
export function getMcpUpload(uploadId: string) { return descriptor(load(uploadId, false)); }
export function appendMcpUpload(input: { uploadId: string; offset: number; data: string }) {
  if (input.data.length > 65536) throw new McpOperationError("INVALID_ARGUMENT", "上传片段过大");
  const bytes = Buffer.from(input.data, "base64");
  if (!bytes.length || bytes.length > MCP_UPLOAD_CHUNK_BYTES || bytes.toString("base64") !== input.data ||
    !Number.isSafeInteger(input.offset) || input.offset < 0) throw new McpOperationError("INVALID_ARGUMENT", "上传片段或偏移无效");
  return inTransaction(() => {
    const row = load(input.uploadId);
    const existing = getDb().prepare("SELECT bytes FROM mcp_upload_chunks WHERE upload_id=? AND offset=?").get(input.uploadId, input.offset) as { bytes: Uint8Array } | undefined;
    if (existing) {
      if (!Buffer.from(existing.bytes).equals(bytes)) throw new McpOperationError("CONFLICT", "同一上传偏移已经用于其他字节");
      return descriptor(row);
    }
    if (row.status !== "uploading" || row.received_bytes !== input.offset || input.offset + bytes.length > row.byte_length) throw new McpOperationError("CONFLICT", "上传进度已变化，请查询 receivedBytes 后继续");
    assertMcpCacheCapacity(bytes.length);
    getDb().prepare("INSERT INTO mcp_upload_chunks(upload_id,offset,bytes) VALUES(?,?,?)").run(row.upload_id, input.offset, bytes);
    getDb().prepare("UPDATE mcp_uploads SET received_bytes=received_bytes+? WHERE upload_id=?").run(bytes.length, row.upload_id);
    return descriptor(load(row.upload_id));
  });
}
function content(row: Upload) {
  if (row.received_bytes !== row.byte_length) throw new McpOperationError("CONFLICT", "上传尚未完成");
  const chunks = getDb().prepare("SELECT offset,bytes FROM mcp_upload_chunks WHERE upload_id=? ORDER BY offset").all(row.upload_id) as { offset: number; bytes: Uint8Array }[];
  const parts: Buffer[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    if (chunk.offset !== offset || !chunk.bytes.length || chunk.bytes.length > MCP_UPLOAD_CHUNK_BYTES || offset + chunk.bytes.length > row.byte_length) throw new McpOperationError("CONFLICT", "上传片段不连续或已改变");
    parts.push(Buffer.from(chunk.bytes)); offset += chunk.bytes.length;
  }
  if (offset !== row.byte_length) throw new McpOperationError("NOT_FOUND", "上传字节已失效，请重新上传");
  const bytes = Buffer.concat(parts, row.byte_length);
  if (digest(bytes) !== row.sha256) throw new McpOperationError("CONFLICT", "上传 SHA-256 与声明不符，请用新幂等键重新上传");
  return bytes;
}
export function completeMcpUpload(uploadId: string) {
  return inTransaction(() => {
    const row = load(uploadId); content(row);
    getDb().prepare("UPDATE mcp_uploads SET status='complete' WHERE upload_id=?").run(uploadId);
    return descriptor(load(uploadId));
  });
}
/** Return a bounded in-memory snapshot, never a caller-controlled filesystem path. */
export function readMcpUploadBytes(uploadId: string, purpose?: UploadPurpose) {
  return inTransaction(() => {
    const row = load(uploadId);
    if (row.status !== "complete") throw new McpOperationError("CONFLICT", "请先完成并校验上传");
    if (purpose !== undefined && row.purpose !== purpose) throw new McpOperationError("INVALID_ARGUMENT", "文件上传用途不符");
    return { ...descriptor(row), bytes: content(row) };
  });
}
