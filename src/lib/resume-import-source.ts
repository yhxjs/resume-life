import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { dataGeneration, getDb, inTransaction } from "@/lib/db";
import {
  DocumentTableProvenanceError,
  MAX_DOCUMENT_TABLE_PROVENANCE_BYTES,
  parseDocumentTableProvenance,
  serializeDocumentTableProvenance,
  type DocumentTableProvenance,
} from "@/lib/document-table-provenance";
import { isResumeImportSourceId, type ResumeImportSourceReceipt } from "@/lib/resume-import-source-contract";

export const RESUME_IMPORT_SOURCE_TTL_MS = 30 * 60 * 1000;
export const RESUME_IMPORT_SOURCE_MAX_PER_OWNER = 8;
export const RESUME_IMPORT_SOURCE_MAX_TOTAL = 64;
export const RESUME_IMPORT_SOURCE_MAX_OWNER_BYTES = 4 * 1024 * 1024;
export const RESUME_IMPORT_SOURCE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const RESUME_IMPORT_SOURCE_ENTRY_OVERHEAD_BYTES = 512;

export class ResumeImportSourceInputError extends Error {
  constructor() { super("文档来源回执格式无效"); this.name = "ResumeImportSourceInputError"; }
}
export class ResumeImportSourceGoneError extends Error {
  constructor() { super("文档来源回执已失效，请重新上传或明确选择继续普通文本"); this.name = "ResumeImportSourceGoneError"; }
}
export class ResumeImportSourceMismatchError extends Error {
  constructor() { super("正文已变化，请重新上传或明确选择继续普通文本"); this.name = "ResumeImportSourceMismatchError"; }
}
export class ResumeImportSourceCapacityError extends Error {
  constructor(public readonly retryAfter: number) {
    super("文档来源暂存已满，请稍后重试"); this.name = "ResumeImportSourceCapacityError";
  }
}

type SourceRow = {
  text_sha256: string; provenance: string; metadata_bytes: number;
  created_at: number; expires_at: number;
};
type Access = { database: DatabaseSync; time: number; generation: string; sessionExpiresAt: number };
type Result<T> = { value: T } | { error: Error };

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function checkOwner(owner: string): void {
  if (typeof owner !== "string" || !/^[a-f0-9]{64}$/.test(owner)) throw new ResumeImportSourceInputError();
}
function checkId(id: string): void { if (!isResumeImportSourceId(id)) throw new ResumeImportSourceInputError(); }
function checkText(text: string): void { if (typeof text !== "string") throw new ResumeImportSourceInputError(); }

/** Main SQLite owns these ephemeral records across bundles, workers and restarts.
 * No document body, file, raw session token or raw receipt ID is persisted here.
 * Return expected failures from the transaction so pruning survives rejected access.
 */
function access<T>(owner: string, operation: (context: Access) => Result<T>): T {
  checkOwner(owner);
  const result = inTransaction<Result<T>>(() => {
    const database = getDb();
    const time = Date.now();
    const generation = JSON.stringify(dataGeneration(database));
    database.prepare(`DELETE FROM resume_import_source_receipts
      WHERE expires_at <= ? OR created_at > ? OR data_generation <> ?
        OR NOT EXISTS (SELECT 1 FROM auth_sessions a
          WHERE a.token_hash = resume_import_source_receipts.owner_token_hash AND a.expires_at > ?)`)
      .run(time, time, generation, new Date(time).toISOString());
    const session = database.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(owner) as
      { expires_at: string } | undefined;
    const sessionExpiresAt = session ? Date.parse(session.expires_at) : NaN;
    if (!Number.isSafeInteger(sessionExpiresAt) || sessionExpiresAt <= time) {
      return { error: new ResumeImportSourceGoneError() };
    }
    return operation({ database, time, generation, sessionExpiresAt });
  });
  if ("error" in result) throw result.error;
  return result.value;
}

export function issueResumeImportSource(
  ownerTokenHash: string, text: string, provenance: DocumentTableProvenance,
): ResumeImportSourceReceipt {
  checkOwner(ownerTokenHash);
  checkText(text);
  const serialized = serializeDocumentTableProvenance(provenance, text);
  const metadataBytes = Buffer.byteLength(serialized, "utf8");
  const accountedBytes = metadataBytes + RESUME_IMPORT_SOURCE_ENTRY_OVERHEAD_BYTES;
  return access<ResumeImportSourceReceipt>(ownerTokenHash, ({ database, time, generation, sessionExpiresAt }) => {
    // Read actual UTF-8 storage size as well: a corrupt accounting column must not
    // allow admission past the byte limits. The table is bounded by 64 live rows.
    const entries = database.prepare(`SELECT owner_token_hash, metadata_bytes,
      length(CAST(provenance AS BLOB)) AS actual_bytes, created_at, expires_at FROM resume_import_source_receipts`).all() as
      { owner_token_hash: string; metadata_bytes: number; actual_bytes: number; created_at: number; expires_at: number }[];
    if (entries.some(row => !Number.isSafeInteger(row.metadata_bytes) || row.metadata_bytes < 1
        || row.metadata_bytes > MAX_DOCUMENT_TABLE_PROVENANCE_BYTES || row.metadata_bytes !== row.actual_bytes
        || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.expires_at)
        || row.expires_at <= row.created_at || row.expires_at > row.created_at + RESUME_IMPORT_SOURCE_TTL_MS)) {
      throw new DocumentTableProvenanceError();
    }
    const owned = entries.filter(row => row.owner_token_hash === ownerTokenHash);
    const sumBytes = (rows: typeof entries) => rows.reduce((sum, row) => sum + row.actual_bytes + RESUME_IMPORT_SOURCE_ENTRY_OVERHEAD_BYTES, 0);
    const ownerFull = owned.length >= RESUME_IMPORT_SOURCE_MAX_PER_OWNER || sumBytes(owned) + accountedBytes > RESUME_IMPORT_SOURCE_MAX_OWNER_BYTES;
    const globalFull = entries.length >= RESUME_IMPORT_SOURCE_MAX_TOTAL || sumBytes(entries) + accountedBytes > RESUME_IMPORT_SOURCE_MAX_TOTAL_BYTES;
    if (ownerFull || globalFull) {
      const limiting = ownerFull ? owned : entries;
      const firstExpiry = Math.min(...limiting.map(row => row.expires_at));
      return { error: new ResumeImportSourceCapacityError(Math.max(1, Math.ceil((firstExpiry - time) / 1000))) };
    }
    const id = randomBytes(32).toString("base64url");
    const expiresAt = Math.min(time + RESUME_IMPORT_SOURCE_TTL_MS, sessionExpiresAt);
    database.prepare(`INSERT INTO resume_import_source_receipts
      (id_hash,owner_token_hash,data_generation,text_sha256,provenance,metadata_bytes,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(sha256(id), ownerTokenHash, generation, sha256(text), serialized, metadataBytes, time, expiresAt);
    return { value: { version: 1, id, expiresAt } };
  });
}

export function resolveResumeImportSource(ownerTokenHash: string, id: string, text: string): DocumentTableProvenance {
  checkId(id);
  checkText(text);
  return access<DocumentTableProvenance>(ownerTokenHash, ({ database, sessionExpiresAt }) => {
    const row = database.prepare(`SELECT text_sha256,provenance,metadata_bytes,created_at,expires_at
      FROM resume_import_source_receipts WHERE id_hash = ? AND owner_token_hash = ?`).get(sha256(id), ownerTokenHash) as SourceRow | undefined;
    if (!row) return { error: new ResumeImportSourceGoneError() };
    if (typeof row.provenance !== "string" || !Number.isSafeInteger(row.metadata_bytes)
        || row.metadata_bytes > MAX_DOCUMENT_TABLE_PROVENANCE_BYTES || row.metadata_bytes !== Buffer.byteLength(row.provenance, "utf8")
        || !/^[a-f0-9]{64}$/.test(row.text_sha256)
        || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.expires_at)
        || row.expires_at <= row.created_at || row.expires_at > row.created_at + RESUME_IMPORT_SOURCE_TTL_MS
        || row.expires_at > sessionExpiresAt) throw new DocumentTableProvenanceError();
    // Independent binding distinguishes changed request text (409) from damaged
    // stored metadata (500). JSON is never accepted on its own as a source record.
    let storedHash: unknown;
    try { storedHash = (JSON.parse(row.provenance) as { textSha256?: unknown } | null)?.textSha256; }
    catch { throw new DocumentTableProvenanceError(); }
    if (storedHash !== row.text_sha256) throw new DocumentTableProvenanceError();
    if (sha256(text) !== row.text_sha256) return { error: new ResumeImportSourceMismatchError() };
    const provenance = parseDocumentTableProvenance(row.provenance, text);
    if (!provenance) throw new DocumentTableProvenanceError();
    return { value: provenance };
  });
}

/** Unknown and other owners' IDs are deliberately indistinguishable no-ops. */
export function discardResumeImportSource(ownerTokenHash: string, id: string): void {
  checkId(id);
  return access(ownerTokenHash, ({ database }) => {
    database.prepare("DELETE FROM resume_import_source_receipts WHERE id_hash = ? AND owner_token_hash = ?").run(sha256(id), ownerTokenHash);
    return { value: undefined };
  });
}
