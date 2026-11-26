import fs from "node:fs";
import path from "node:path";
import { reportMcpProgress } from "./mcp-progress";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { DATA_DIR, dataGeneration, getDb } from "./db";
import { mcpCreateOnce } from "./mcp-state";
import { McpOperationError } from "./mcp-errors";
import { assertDataGeneration } from "./data-generation";
import { assertOperationActive } from "./operation-deadline";
import { withMcpWorkLease } from "./mcp-work-leases";
import { assertMcpCacheCapacity, assertMcpCacheFresh } from "./mcp-cache";

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_CACHE_BYTES = 2 * MAX_ARTIFACT_BYTES;
const MAX_CACHE_ENTRIES = 16;
const verifiedFiles = new Map<string, { fingerprint: string; sha256: string; bytes: Buffer }>();
let cachedBytes = 0;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const manifestSchema = z.strictObject({ artifactId: z.string().regex(/^[a-f0-9]{64}$/), creator: z.enum(["export_resume", "export_portfolio"]),
  requestKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), generation: z.string(), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), filename: z.string().min(1).max(240), mimeType: z.string().max(100),
  byteLength: z.number().int().min(0).max(MAX_ARTIFACT_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string() });
type Manifest = z.infer<typeof manifestSchema>;
type Creator = Manifest["creator"];
function root() {
  const dir = path.join(DATA_DIR, "mcp-artifacts");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new McpOperationError("CONFIGURATION", "产物目录不能是符号链接");
  return dir;
}
function artifactPath(id: string, ext: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new McpOperationError("INVALID_ARGUMENT", "产物标识无效");
  return path.join(root(), `${id}.${ext}`);
}
function load(id: string): Manifest {
  const file = artifactPath(id, "json");
  if (!fs.existsSync(file)) throw new McpOperationError("NOT_FOUND", "产物不存在，请使用新幂等键重新导出");
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16_384) throw new McpOperationError("INVALID_ARGUMENT", "产物元数据无效");
  const parsed = manifestSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success || parsed.data.artifactId !== id) throw new McpOperationError("INVALID_ARGUMENT", "产物元数据无效");
  return parsed.data;
}
const receiptId = (id: string) => Number.parseInt(id.slice(0, 13), 16) || 1;
function validateReceipt(manifest: Manifest) {
  const receipt = getDb().prepare("SELECT generation,input_hash,target_id,created_at FROM mcp_creation_receipts WHERE tool=? AND request_key=?")
    .get(manifest.creator, manifest.requestKey) as { generation: string; input_hash: string; target_id: number; created_at: string } | undefined;
  if (!receipt) throw new McpOperationError("NOT_FOUND", "产物尚未提交或已失效");
  if (manifest.generation !== (dataGeneration() ?? "initial") || receipt.generation !== manifest.generation) throw new McpOperationError("CONFLICT", "数据已恢复，旧导出产物已失效");
  if (receipt.input_hash !== manifest.inputHash || receipt.target_id !== receiptId(manifest.artifactId)) throw new McpOperationError("CONFLICT", "产物与导出回执不一致");
  assertMcpCacheFresh(receipt.created_at);
}
export function artifactDescriptor(manifest: Manifest) {
  return { artifactId: manifest.artifactId, filename: manifest.filename, mimeType: manifest.mimeType, byteLength: manifest.byteLength,
    sha256: manifest.sha256, sourceRevision: manifest.sourceRevision, createdAt: manifest.createdAt,
    read: { tool: "read_export_artifact" as const, artifactId: manifest.artifactId, offset: 0 } };
}
function atomicWrite(file: string, bytes: Buffer | string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function fingerprint(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(":");
}
function fileState(file: string, byteLength: number): string {
  let stat: fs.BigIntStats;
  try { stat = fs.lstatSync(file, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new McpOperationError("NOT_FOUND", "产物文件不存在，请重新导出");
    throw error;
  }
  if (!stat.isFile() || stat.size !== BigInt(byteLength)) throw new McpOperationError("CONFLICT", "产物文件已改变");
  return fingerprint(stat);
}
function forgetFile(file: string) {
  const cached = verifiedFiles.get(file);
  if (cached) { cachedBytes -= cached.bytes.length; verifiedFiles.delete(file); }
}
function verifiedBytes(file: string, manifest: Manifest): Buffer {
  const before = fileState(file, manifest.byteLength);
  const cached = verifiedFiles.get(file);
  if (cached?.fingerprint === before && cached.sha256 === manifest.sha256) {
    verifiedFiles.delete(file); verifiedFiles.set(file, cached);
    return cached.bytes;
  }
  forgetFile(file);
  // 每个文件状态仅完整读取、校验一次；大小、身份或时间戳变化都使缓存失效。
  // 固定大小读取并核对同一个句柄，避免并发替换路径或增长文件绕过内存上限。
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || fingerprint(opened) !== before) throw new McpOperationError("CONFLICT", "产物文件已改变");
    bytes = Buffer.alloc(manifest.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new McpOperationError("CONFLICT", "产物文件已改变");
      offset += count;
    }
    if (fingerprint(fs.fstatSync(fd, { bigint: true })) !== before || fileState(file, manifest.byteLength) !== before) {
      throw new McpOperationError("CONFLICT", "产物文件已改变");
    }
    if (hash(bytes) !== manifest.sha256) throw new McpOperationError("CONFLICT", "产物校验和不一致");
  } finally { fs.closeSync(fd); }
  while (cachedBytes + bytes.length > MAX_CACHE_BYTES || verifiedFiles.size >= MAX_CACHE_ENTRIES) {
    forgetFile(verifiedFiles.keys().next().value!);
  }
  verifiedFiles.set(file, { fingerprint: before, sha256: manifest.sha256, bytes });
  cachedBytes += bytes.length;
  return bytes;
}
/** Files become readable only with the atomic DB receipt. Restores invalidate receipts and cached files together. */
export async function createMcpArtifact(creator: Creator, key: string, payload: object,
  render: (signal: AbortSignal) => Promise<{ bytes: Buffer; filename: string; mimeType: string; sourceRevision: string; validate: () => void }>, signal: AbortSignal = new AbortController().signal) {
  const artifactId = hash(JSON.stringify([creator, key]));
  const existing = getDb().prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool=? AND request_key=?").get(creator, key);
  if (existing) {
    mcpCreateOnce(creator, key, payload, () => { throw new Error("Existing artifact receipt disappeared"); }, () => fs.existsSync(artifactPath(artifactId, "json")) && fs.existsSync(artifactPath(artifactId, "bin")));
    const manifest = load(artifactId); validateReceipt(manifest); return artifactDescriptor(manifest);
  }
  const generation = dataGeneration() ?? "initial";
  return withMcpWorkLease("render", signal, async activeSignal => {
  reportMcpProgress("rendering", 0, 1, "files");
  const output = await render(activeSignal);
  if (output.bytes.length > MAX_ARTIFACT_BYTES) throw new McpOperationError("INVALID_ARGUMENT", "导出文件超过 20 MiB 上限，请减少选材");
  assertOperationActive(); assertDataGeneration();
  if (generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "数据已恢复，请重新读取来源");
  reportMcpProgress("committing", output.bytes.length, output.bytes.length, "bytes");
  mcpCreateOnce(creator, key, payload, () => {
    output.validate(); assertOperationActive(); assertDataGeneration();
    const manifest = manifestSchema.parse({ artifactId, creator, requestKey: key, generation, inputHash: hash(JSON.stringify(payload)),
      sourceRevision: output.sourceRevision, filename: output.filename, mimeType: output.mimeType, byteLength: output.bytes.length,
      sha256: hash(output.bytes), createdAt: new Date().toISOString() });
    assertMcpCacheCapacity(output.bytes.length + Buffer.byteLength(JSON.stringify(manifest)));
    atomicWrite(artifactPath(artifactId, "bin"), output.bytes);
    atomicWrite(artifactPath(artifactId, "json"), JSON.stringify(manifest));
    return { id: receiptId(artifactId) };
  }, () => fs.existsSync(artifactPath(artifactId, "json")) && fs.existsSync(artifactPath(artifactId, "bin")));
  const manifest = load(artifactId); validateReceipt(manifest); return artifactDescriptor(manifest);
  });
}

export function recoverMcpArtifact(creator: Creator, key: string) {
  if (!getDb().prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool=? AND request_key=?").get(creator, key)) return undefined;
  const manifest = load(hash(JSON.stringify([creator, key]))); validateReceipt(manifest); return artifactDescriptor(manifest);
}
export function readMcpArtifact(input: { artifactId: string; offset?: number; length?: number }, authorize: (creator: Creator) => void) {
  const manifest = load(input.artifactId); authorize(manifest.creator); validateReceipt(manifest);
  const file = artifactPath(input.artifactId, "bin"), offset = input.offset ?? 0, length = input.length ?? 8000;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > manifest.byteLength || !Number.isInteger(length) || length < 1 || length > 8000) throw new McpOperationError("INVALID_ARGUMENT", "产物分段参数无效");
  const bytes = verifiedBytes(file, manifest);
  const end = Math.min(bytes.length, offset + length);
  return { ...artifactDescriptor(manifest), encoding: "base64" as const, offset, data: bytes.subarray(offset, end).toString("base64"), nextOffset: end < bytes.length ? end : null };
}
