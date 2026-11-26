import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR, dataGeneration, getDb, inTransaction, now } from "./db";
import { McpOperationError } from "./mcp-errors";
import { readMcpCachePolicy } from "@/mcp/cache-config.mjs";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Candidate = { kind: "artifact" | "orphan" | "result" | "job" | "upload"; id: string; bytes: number; reason: "expired" | "restored" | "orphan";
  files?: { name: string; fingerprint: string }[]; tool?: string; key?: string };
export function mcpCachePolicy() {
  try { return readMcpCachePolicy(); }
  catch (error) { throw new McpOperationError("CONFIGURATION", error instanceof Error ? error.message : "缓存配置无效"); }
}
export function assertMcpCacheFresh(createdAt: string) {
  if (Number.isFinite(Date.parse(createdAt)) && Date.parse(createdAt) + mcpCachePolicy().ttlHours * 3_600_000 <= Date.now()) {
    throw new McpOperationError("NOT_FOUND", "缓存结果已过期，请核对正式记录并用新幂等键重新生成");
  }
}
function stamp(stat: fs.BigIntStats) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":"); }
function cacheRoot() {
  const root = path.join(DATA_DIR, "mcp-artifacts");
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpOperationError("CONFIGURATION", "产物缓存目录无效");
  }
  return root;
}

function inventory() {
  const policy = mcpCachePolicy(), generation = dataGeneration() ?? "initial", cutoff = Date.now() - policy.ttlHours * 3_600_000;
  const db = getDb(), candidates: Candidate[] = [];
  const running = db.prepare("SELECT operation,request_key FROM mcp_jobs WHERE status='running' AND lease_expires_at > ? AND deadline_at > ? AND generation=?")
    .all(now(), now(), generation) as { operation: string; request_key: string }[];
  const protectedKeys = new Set(running.map(row => JSON.stringify([row.operation, row.request_key])));
  const results = db.prepare(`SELECT o.tool,o.request_key,r.created_at,r.generation,length(CAST(o.result_json AS BLOB)) AS bytes
    FROM mcp_operation_results o JOIN mcp_creation_receipts r ON r.tool=o.tool AND r.request_key=o.request_key`).all() as
    { tool: string; request_key: string; created_at: string; generation: string; bytes: number }[];
  let totalBytes = 0, artifactCount = 0;
  for (const row of results) {
    totalBytes += row.bytes;
    if (!protectedKeys.has(JSON.stringify([row.tool, row.request_key])) && (row.generation !== generation || Date.parse(row.created_at) <= cutoff)) {
      candidates.push({ kind: "result", id: hash([row.tool, row.request_key]), bytes: row.bytes, reason: row.generation !== generation ? "restored" : "expired", tool: row.tool, key: row.request_key });
    }
  }
  const jobs = db.prepare("SELECT job_id,status,generation,updated_at,lease_expires_at,deadline_at,length(CAST(COALESCE(payload_json,'') || COALESCE(result_json,'') AS BLOB)) AS bytes FROM mcp_jobs WHERE payload_json IS NOT NULL OR result_json IS NOT NULL")
    .all() as { job_id: string; status: string; generation: string; updated_at: string; lease_expires_at: string; deadline_at: string; bytes: number }[];
  for (const row of jobs) {
    totalBytes += row.bytes;
    const running = row.status === "running" && row.generation === generation && row.lease_expires_at > now() && row.deadline_at > now();
    if (!running && (row.generation !== generation || Date.parse(row.updated_at) <= cutoff)) candidates.push({ kind: "job", id: row.job_id, bytes: row.bytes, reason: row.generation !== generation ? "restored" : "expired" });
  }
  const uploads = db.prepare("SELECT u.upload_id,u.generation,u.created_at,COALESCE(SUM(length(c.bytes)),0) AS bytes,COUNT(c.offset) AS chunks FROM mcp_uploads u LEFT JOIN mcp_upload_chunks c ON c.upload_id=u.upload_id GROUP BY u.upload_id")
    .all() as { upload_id: string; generation: string; created_at: string; bytes: number; chunks: number }[];
  let uploadEntries = 0;
  for (const row of uploads) {
    const active = row.generation === generation && Date.parse(row.created_at) > cutoff;
    totalBytes += row.bytes + (active ? 512 : 0);
    if (row.bytes || active) uploadEntries += 1 + row.chunks;
    if (row.bytes && (row.generation !== generation || Date.parse(row.created_at) <= cutoff)) candidates.push({ kind: "upload", id: row.upload_id, bytes: row.bytes, reason: row.generation !== generation ? "restored" : "expired" });
  }
  const root = cacheRoot(), names = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const receipts = db.prepare("SELECT tool,request_key,created_at,generation FROM mcp_creation_receipts WHERE tool IN ('export_resume','export_portfolio')")
    .all() as { tool: string; request_key: string; created_at: string; generation: string }[];
  const byId = new Map(receipts.map(row => [hash([row.tool, row.request_key]), row]));
  const groups = new Map<string, { name: string; fingerprint: string; bytes: number; modified: number }[]>();
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.(?:json|bin)(?:\.[a-f0-9-]+\.tmp)?$/.test(name)) continue;
    const stat = fs.lstatSync(path.join(root, name), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const bytes = Number(stat.size); totalBytes += bytes;
    const id = name.endsWith(".tmp") ? name : name.slice(0, 64);
    groups.set(id, [...(groups.get(id) ?? []), { name, fingerprint: stamp(stat), bytes, modified: Number(stat.mtimeMs) }]);
  }
  for (const [id, files] of groups) {
    const receipt = byId.get(id), bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    if (receipt) {
      artifactCount++;
      if (protectedKeys.has(JSON.stringify([receipt.tool, receipt.request_key]))) continue;
      if (receipt.generation !== generation || Date.parse(receipt.created_at) <= cutoff) candidates.push({ kind: "artifact", id, bytes,
        reason: receipt.generation !== generation ? "restored" : "expired", files });
    } else if (files.every(file => file.modified <= Date.now() - policy.orphanGraceHours * 3_600_000)) {
      candidates.push({ kind: "orphan", id: hash(id), bytes, reason: "orphan", files });
    }
  }
  candidates.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { policy, generation, totalBytes, artifactCount, resultCount: results.length, jobCacheCount: jobs.length, uploadCacheCount: uploads.filter(row => row.bytes).length, entryCount: names.length + results.length + jobs.length + uploadEntries, candidates };
}
function preview(limit: number) {
  const state = inventory();
  const candidates = state.candidates.slice(0, limit);
  return { ...state, candidates, remainingCandidates: state.candidates.length - candidates.length,
    previewToken: hash([state.generation, state.policy, state.totalBytes, candidates]) };
}
export function previewMcpCache(limit = 100) {
  return inTransaction(() => {
    const state = preview(limit);
    return { policy: state.policy, totalBytes: state.totalBytes, artifactCount: state.artifactCount, resultCount: state.resultCount, jobCacheCount: state.jobCacheCount, uploadCacheCount: state.uploadCacheCount,
      candidates: state.candidates.map(({ kind, id, bytes, reason }) => ({ kind, id, bytes, reason })), remainingCandidates: state.remainingCandidates, previewToken: state.previewToken };
  });
}
export function maintainMcpCache(limit = 100, expectedPreviewToken?: string) {
  return inTransaction(() => {
    const state = preview(limit);
    if (expectedPreviewToken !== undefined && state.previewToken !== expectedPreviewToken) throw new McpOperationError("CONFLICT", "缓存清理预览已变化，请重新读取");
    const db = getDb(), root = cacheRoot();
    let removedEntries = 0, removedBytes = 0;
    for (const entry of state.candidates) {
      if (entry.files) {
        const files = entry.files.map(file => ({ ...file, path: path.join(root, file.name) }));
        if (files.some(file => !fs.existsSync(file.path) || stamp(fs.lstatSync(file.path, { bigint: true })) !== file.fingerprint)) continue;
        // Only expired cache files, never business uploads. Receipts remain as tombstones.
        for (const file of files) fs.unlinkSync(file.path);
      } else if (entry.kind === "result") db.prepare("DELETE FROM mcp_operation_results WHERE tool=? AND request_key=?").run(entry.tool!, entry.key!);
      else if (entry.kind === "upload") db.prepare("DELETE FROM mcp_upload_chunks WHERE upload_id=?").run(entry.id);
      else db.prepare("UPDATE mcp_jobs SET payload_json=NULL,result_json=NULL,status=CASE WHEN status='running' THEN 'interrupted' ELSE status END,error_code=CASE WHEN status='running' THEN 'CANCELLED' ELSE error_code END WHERE job_id=?").run(entry.id);
      removedEntries++; removedBytes += entry.bytes;
    }
    return { removedEntries, removedBytes, remainingCandidates: state.remainingCandidates };
  });
}
export function assertMcpCacheCapacity(additionalBytes: number) {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new McpOperationError("INVALID_ARGUMENT", "缓存大小无效");
  const state = inventory();
  if (state.entryCount >= state.policy.maxEntries) throw new McpOperationError("BUSY", "缓存条目数量达到上限，请先清理过期缓存");
  if (state.totalBytes + additionalBytes > state.policy.maxBytes) throw new McpOperationError("BUSY", "MCP 缓存容量不足，请预览并清理过期缓存或调整容量后重试");
}
