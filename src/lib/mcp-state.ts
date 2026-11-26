import { createHash } from "node:crypto";
import { dataGeneration, getDb, inTransaction, now } from "./db";
import { withoutWaitingForLock } from "./operation-deadline";
import { McpOperationError } from "./mcp-errors";
import { assertMcpCacheCapacity, assertMcpCacheFresh } from "./mcp-cache";

/** Receipt and business mutation commit together. Keep tombstones across deletion/restore. */
export function mcpCreateOnce(tool: string, key: string, input: object,
  create: () => { id: number }, exists: (id: number) => boolean): { id: number } {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new McpOperationError("INVALID_ARGUMENT", "幂等键需为 8–128 位字母、数字或 ._:-");
  return inTransaction(() => {
    const db = getDb();
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const generation = dataGeneration() ?? "initial";
    const receipt = db.prepare("SELECT input_hash, generation, target_id FROM mcp_creation_receipts WHERE tool = ? AND request_key = ?")
      .get(tool, key) as { input_hash: string; generation: string; target_id: number } | undefined;
    if (receipt) {
      if (receipt.input_hash !== hash) throw new McpOperationError("CONFLICT", "此幂等键已用于不同内容，请使用新的幂等键");
      if (receipt.generation !== generation) throw new McpOperationError("CONFLICT", "数据已恢复，请核对当前记录并使用新的幂等键");
      if (!exists(receipt.target_id)) throw new McpOperationError("CONFLICT", "此前创建的记录已删除，请核对后使用新的幂等键");
      return { id: receipt.target_id };
    }
    const result = create();
    db.prepare("INSERT INTO mcp_creation_receipts (tool, request_key, input_hash, generation, target_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tool, key, hash, generation, result.id, now());
    // The creation capability never grants access to subsequent edits, even on replay.
    return { id: result.id };
  });
}

export function recordMcpOperation(input: { requestId: string; tool: string; targetId: number | null; errorCode?: string; durationMs: number }) {
  // Diagnostic failures must never turn a committed operation into an apparent failure.
  try {
    withoutWaitingForLock(() => inTransaction(() => {
      const db = getDb();
      db.prepare("INSERT INTO mcp_operation_logs (request_id, tool, target_id, status, error_code, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.requestId, input.tool, input.targetId, input.errorCode ? "error" : "success", input.errorCode ?? null, Math.max(0, Math.round(input.durationMs)), now());
      db.exec("DELETE FROM mcp_operation_logs WHERE id < (SELECT id FROM mcp_operation_logs ORDER BY id DESC LIMIT 1 OFFSET 4999)");
    }));
  } catch { console.error("[mcp] 操作记录写入失败"); }
}

/** Multi-record operations retain their exact result alongside the receipt in one transaction. */
export function mcpCreateWithResult<T extends { id: number }>(tool: string, key: string, input: object, create: () => T, exists: (id: number) => boolean): T {
  return inTransaction(() => {
    let created: T | undefined;
    mcpCreateOnce(tool, key, input, () => { created = create(); return { id: created.id }; }, exists);
    if (created) {
      const result = JSON.stringify(created);
      if (Buffer.byteLength(result) > 2 * 1024 * 1024) throw new McpOperationError("INVALID_ARGUMENT", "批量操作结果过大，请分批提交");
      assertMcpCacheCapacity(Buffer.byteLength(result));
      getDb().prepare("INSERT INTO mcp_operation_results(tool,request_key,result_json) VALUES(?,?,?)").run(tool, key, result);
      return created;
    }
    return readMcpOperationResult(tool, key) as T;
  });
}

export function readMcpOperationResult(tool: string, key: string): object {
  const row = getDb().prepare(`SELECT r.generation,r.created_at,o.result_json FROM mcp_creation_receipts r
    LEFT JOIN mcp_operation_results o ON o.tool=r.tool AND o.request_key=r.request_key WHERE r.tool=? AND r.request_key=?`)
    .get(tool, key) as { generation: string; created_at: string; result_json: string | null } | undefined;
  if (!row) throw new McpOperationError("NOT_FOUND", "操作回执不存在");
  if (row.generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "数据已恢复，旧批量结果失效");
  if (!row.result_json) throw new McpOperationError("NOT_FOUND", "操作结果已失效");
  assertMcpCacheFresh(row.created_at);
  return JSON.parse(row.result_json) as object;
}
