import { createHash, randomUUID } from "node:crypto";
import { dataGeneration, getDb, inTransaction, now } from "./db";
import { fitPage, pageParams, type PageInput } from "./mcp-read";
import { McpOperationError, type McpErrorCode } from "./mcp-errors";
import { remainingOperationTimeMs, withCleanupLockBudget } from "./operation-deadline";

export type McpDraftKind = "jd" | "diagnosis" | "review";
type GenerationInput = { kind: McpDraftKind; applicationId: number; interviewId?: number };
export type McpGenerationRequest = {
  request_key: string; input_hash: string; generation: string; kind: McpDraftKind; application_id: number; interview_id: number | null;
  source_revision: string; owner_token: string; status: "pending" | "succeeded" | "failed"; draft_id: number | null;
  response_json: string | null; error_code: McpErrorCode | null; created_at: string; updated_at: string; lease_expires_at: string; draft_expires_at: string | null;
};
type DraftRow = { id: number; kind: McpDraftKind; application_id: number; interview_id: number | null; source_revision: string; created_at: string; expires_at: string; payload?: string };
const targets = { jd: "jd_portraits", diagnosis: "resume_diagnoses", review: "application_interview_recaps" } as const;
const fingerprint = (input: GenerationInput) => createHash("sha256").update(JSON.stringify([input.kind, input.applicationId, input.interviewId ?? null])).digest("hex");

export function findMcpGenerationRequest(key: string, input?: GenerationInput) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new McpOperationError("INVALID_ARGUMENT", "生成请求幂等键需为 8–128 位字母、数字或 ._:-");
  const row = getDb().prepare("SELECT * FROM mcp_generation_requests WHERE request_key = ?").get(key) as McpGenerationRequest | undefined;
  if (row && input && row.input_hash !== fingerprint(input)) throw new McpOperationError("CONFLICT", "此生成请求幂等键已用于不同工具或资料，请使用新的键");
  return row;
}

/** Called inside the same transaction that reads and validates the source. Never hold the lock across a model request. */
export function beginMcpGeneration(key: string, input: GenerationInput, sourceRevision: string) {
  const timestamp = now();
  const owner = randomUUID();
  getDb().prepare(`INSERT INTO mcp_generation_requests
    (request_key,input_hash,generation,kind,application_id,interview_id,source_revision,owner_token,status,created_at,updated_at,lease_expires_at)
    VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`)
    .run(key, fingerprint(input), dataGeneration() ?? "initial", input.kind, input.applicationId, input.interviewId ?? null, sourceRevision, owner,
      timestamp, timestamp, new Date(Date.now() + remainingOperationTimeMs()).toISOString());
  return findMcpGenerationRequest(key)!;
}

export function savedMcpDraftRecord(draftId: number, kind: McpDraftKind) {
  const db = getDb();
  const receipt = db.prepare("SELECT target_id, generation FROM mcp_creation_receipts WHERE tool = ? AND request_key = ?")
    .get(`save_ai_draft:${kind}`, `mcp-draft:${draftId}`) as { target_id: number; generation: string } | undefined;
  if (!receipt || receipt.generation !== (dataGeneration() ?? "initial") || !db.prepare(`SELECT 1 FROM ${targets[kind]} WHERE id = ?`).get(receipt.target_id)) return null;
  return { id: receipt.target_id, kind };
}

export function completeMcpGeneration(request: McpGenerationRequest, response: { draftId: number; expiresAt: string } & object) {
  const result = getDb().prepare(`UPDATE mcp_generation_requests SET status='succeeded',draft_id=?,response_json=?,draft_expires_at=?,updated_at=?
    WHERE request_key=? AND owner_token=? AND generation=? AND status='pending'`)
    .run(response.draftId, JSON.stringify(response), response.expiresAt, now(), request.request_key, request.owner_token, request.generation);
  if (!result.changes) throw new McpOperationError("CONFLICT", "生成请求状态已变化，请查询请求状态");
}

export function failMcpGeneration(request: McpGenerationRequest, errorCode: McpErrorCode) {
  try {
    withCleanupLockBudget(() => inTransaction(() => {
      getDb().prepare("UPDATE mcp_generation_requests SET status='failed',error_code=?,updated_at=? WHERE request_key=? AND owner_token=? AND generation=? AND status='pending'")
        .run(errorCode, now(), request.request_key, request.owner_token, request.generation);
    }), 0);
  } catch { console.error("[mcp] 生成请求状态写入失败"); }
}

/** Expired payloads can be discarded; request tombstones still prevent another paid call. */
export function clearUnavailableMcpGenerationPayloads() {
  getDb().prepare(`UPDATE mcp_generation_requests SET response_json=NULL WHERE response_json IS NOT NULL AND
    NOT EXISTS (SELECT 1 FROM mcp_drafts d WHERE d.id=mcp_generation_requests.draft_id AND d.expires_at > ?)`)
    .run(now());
}

export function replayMcpGeneration(request: McpGenerationRequest): object {
  if (request.generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "数据已恢复，此生成请求已失效，请核对后使用新的键");
  if (request.status === "pending") {
    if (request.lease_expires_at > now()) throw new McpOperationError("BUSY", "此生成请求仍在进行，请查询 get_ai_generation_request 后重试同一键");
    throw new McpOperationError("CONFLICT", "此生成请求已中断，结果无法确认；请查询请求状态，同一键不会再次调用模型");
  }
  if (request.status === "failed") throw new McpOperationError("CONFLICT", "此前生成请求已失败，请查询请求状态；同一键不会再次调用模型");
  if (!request.draft_id || !request.response_json || !getDb().prepare("SELECT 1 FROM mcp_drafts WHERE id=? AND expires_at > ?").get(request.draft_id, now())) {
    throw new McpOperationError("CONFLICT", "草稿已过期或不可用，请查询 get_ai_generation_request 查找已保存记录");
  }
  const savedRecord = savedMcpDraftRecord(request.draft_id, request.kind);
  return { ...JSON.parse(request.response_json), saved: savedRecord !== null, savedRecord };
}

export function getMcpGenerationRequest(key: string) {
  const row = findMcpGenerationRequest(key);
  if (!row) throw new McpOperationError("NOT_FOUND", "生成请求不存在");
  const valid = row.generation === (dataGeneration() ?? "initial");
  const draftAvailable = valid && row.draft_id !== null && Boolean(getDb().prepare("SELECT 1 FROM mcp_drafts WHERE id=? AND expires_at > ?").get(row.draft_id, now()));
  const savedRecord = valid && row.draft_id !== null ? savedMcpDraftRecord(row.draft_id, row.kind) : null;
  return { idempotencyKey: row.request_key, kind: row.kind, applicationId: row.application_id, interviewId: row.interview_id,
    sourceRevision: row.source_revision, status: !valid ? "invalidated" : row.status === "pending" && row.lease_expires_at <= now() ? "interrupted" : row.status,
    draftId: valid ? row.draft_id : null, draftAvailable, expiresAt: row.draft_expires_at, saved: savedRecord !== null, savedRecord,
    errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
}

function draftMetadata(row: DraftRow) {
  const savedRecord = savedMcpDraftRecord(row.id, row.kind);
  const request = getDb().prepare("SELECT request_key FROM mcp_generation_requests WHERE draft_id=? AND generation=?")
    .get(row.id, dataGeneration() ?? "initial") as { request_key: string } | undefined;
  return { ...row, idempotencyKey: request?.request_key ?? null, expired: row.expires_at <= now(), saved: savedRecord !== null, savedRecord };
}

export function readMcpDraft(id: number) {
  const row = getDb().prepare("SELECT id,kind,application_id,interview_id,source_revision,payload,created_at,expires_at FROM mcp_drafts WHERE id=? AND expires_at > ?")
    .get(id, now()) as DraftRow | undefined;
  return row ? draftMetadata(row) : null;
}

export function listMcpDrafts(input: PageInput & { applicationId?: number; kind?: McpDraftKind; includeExpired?: boolean }) {
  const { limit, idCursor } = pageParams(input);
  const rows = getDb().prepare(`SELECT id,kind,application_id,interview_id,source_revision,created_at,expires_at FROM mcp_drafts
    WHERE (? IS NULL OR application_id=?) AND (? IS NULL OR kind=?) AND (? OR expires_at > ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`)
    .all(input.applicationId ?? null, input.applicationId ?? null, input.kind ?? null, input.kind ?? null, input.includeExpired ? 1 : 0, now(), idCursor, idCursor, limit + 1) as DraftRow[];
  const items = rows.slice(0, limit).map(draftMetadata);
  return fitPage(items, rows.length > limit ? String(items.at(-1)!.id) : null, item => String(item.id));
}
