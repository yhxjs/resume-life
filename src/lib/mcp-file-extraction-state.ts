import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dataGeneration, getDb, inTransaction, now } from "./db";
import { McpOperationError, type McpErrorCode } from "./mcp-errors";
import { mcpCreateOnce, mcpCreateWithResult, readMcpOperationResult } from "./mcp-state";
import { isMcpProcessAlive } from "./mcp-work-leases";
import { remainingOperationTimeMs, withCleanupLockBudget } from "./operation-deadline";

// Separate from the completed extraction receipt. Cleanup may discard this state,
// but its receipt survives so an interrupted/expired key never starts OCR again.
const TOOL = "extract_uploaded_file:attempt";
type ExtractionAttempt = {
  id: number; owner: string; pid: number; generation: string; deadlineAt: string;
  status: "pending" | "succeeded" | "failed"; errorCode: McpErrorCode | null;
};

class FileExtractionPendingError extends McpOperationError {
  constructor() { super("BUSY", "此提取请求仍在执行，请稍后用 get_file_extraction 查询或重试同一键", { retryable: true }); }
}

/** A job can wait for another owner, but must never retry a claimed failure. */
export async function awaitFileExtraction<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    try { return await run(); }
    catch (error) {
      if (!(error instanceof FileExtractionPendingError)) throw error;
      try { await delay(100, undefined, { signal }); }
      catch (error) { signal.throwIfAborted(); throw error; }
    }
  }
}

export function checkFileExtractionAttempt(key: string, input?: object): void {
  if (!getDb().prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool=? AND request_key=?").get(TOOL, key)) return;
  if (input) mcpCreateOnce(TOOL, key, input, () => { throw new Error("Extraction attempt disappeared"); }, () => true);
  let attempt: ExtractionAttempt;
  try { attempt = readMcpOperationResult(TOOL, key) as ExtractionAttempt; }
  catch (error) {
    if (!(error instanceof McpOperationError) || error.code !== "NOT_FOUND") throw error;
    throw new McpOperationError("CONFLICT", "提取请求状态已过期；同一键不会重新执行，请核对后使用新键");
  }
  if (attempt.status === "pending" && attempt.deadlineAt > now() && isMcpProcessAlive(attempt.pid)) {
    throw new FileExtractionPendingError();
  }
  throw new McpOperationError(attempt.errorCode ?? "CONFLICT",
    "此前提取请求未完成或结果已失效；同一键不会重新执行，请核对后使用新键", { retryable: false });
}

/** Caller holds the same transaction used to recheck the completed receipt. */
export function claimFileExtraction(key: string, input: object): ExtractionAttempt {
  return inTransaction(() => {
    checkFileExtractionAttempt(key, input);
    return mcpCreateWithResult(TOOL, key, input, (): ExtractionAttempt => ({
      id: 1, owner: randomUUID(), pid: process.pid, generation: dataGeneration() ?? "initial",
      deadlineAt: new Date(Date.now() + remainingOperationTimeMs()).toISOString(), status: "pending", errorCode: null,
    }), () => true);
  });
}

function transition(key: string, attempt: ExtractionAttempt, errorCode: McpErrorCode | null) {
  if (attempt.generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "数据已恢复，提取请求已失效");
  const result = getDb().prepare(`UPDATE mcp_operation_results SET result_json=? WHERE tool=? AND request_key=?
    AND json_extract(result_json,'$.owner')=? AND json_extract(result_json,'$.status')='pending'
    AND EXISTS (SELECT 1 FROM mcp_creation_receipts WHERE tool=? AND request_key=? AND generation=?)`)
    .run(JSON.stringify({ ...attempt, status: errorCode ? "failed" : "succeeded", errorCode }), TOOL, key, attempt.owner, TOOL, key, attempt.generation);
  if (!result.changes) throw new McpOperationError("CONFLICT", "提取请求状态已变化，请核对原请求");
}

/** Commit together with the completed extraction and result. */
export function completeFileExtraction(key: string, attempt: ExtractionAttempt) {
  if (attempt.deadlineAt <= now()) throw new McpOperationError("TIMEOUT", "提取请求已超时");
  transition(key, attempt, null);
}

export function failFileExtraction(key: string, attempt: ExtractionAttempt, errorCode: McpErrorCode) {
  try { withCleanupLockBudget(() => inTransaction(() => transition(key, attempt, errorCode)), 0); }
  catch { /* The durable attempt receipt still prevents a second OCR call. */ }
}
