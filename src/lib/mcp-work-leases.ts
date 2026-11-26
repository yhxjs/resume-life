import { randomUUID } from "node:crypto";
import { dataGeneration, getDb, inTransaction, now } from "./db";
import { withoutDataGenerationScope } from "./data-generation";
import { McpOperationError } from "./mcp-errors";
import { withOperationGuard, withOperationLimits } from "./operation-deadline";
import { hasMcpProgressReporter, reportMcpProgress } from "./mcp-progress";
import { setTimeout as delay } from "node:timers/promises";

export type McpWorkResource = "render" | "capture" | "parse";
export const MCP_WORK_LEASE_MS = 30_000;
const limits: Record<McpWorkResource, number> = { render: 2, capture: 2, parse: 2 };

export function isMcpProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function mcpCleanupScope<T>(run: () => T): T {
  return withoutDataGenerationScope(() => withOperationLimits({ maxLockWaitMs: 0 }, run));
}

/** One shared pool per data directory, including legacy synchronous calls. */
export async function withMcpWorkLease<T>(resource: McpWorkResource, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const db = getDb(), generation = dataGeneration(db) ?? "initial", token = randomUUID();
  for (;;) {
    signal.throwIfAborted();
    try { inTransaction(() => {
    const rows = db.prepare("SELECT token,owner_pid FROM mcp_work_leases WHERE resource=?").all(resource) as { token: string; owner_pid: number }[];
    for (const row of rows) if (!isMcpProcessAlive(row.owner_pid)) db.prepare("DELETE FROM mcp_work_leases WHERE token=?").run(row.token);
    db.prepare("DELETE FROM mcp_work_leases WHERE expires_at <= ? OR generation <> ?").run(now(), generation);
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM mcp_work_leases WHERE resource=?").get(resource) as { count: number };
    if (count >= limits[resource]) throw new McpOperationError("BUSY", "同一数据目录的任务并发已满，请稍后以原参数和幂等键重试");
    db.prepare("INSERT INTO mcp_work_leases(token,resource,generation,owner_pid,expires_at) VALUES(?,?,?,?,?)")
      .run(token, resource, generation, process.pid, new Date(Date.now() + MCP_WORK_LEASE_MS).toISOString());
    }); break; }
    catch (error) {
      if (!(error instanceof McpOperationError) || error.code !== "BUSY" || !hasMcpProgressReporter()) throw error;
      reportMcpProgress("waiting_resource");
      await delay(200, undefined, { signal });
    }
  }
  const lost = new AbortController();
  const combined = AbortSignal.any([signal, lost.signal]);
  const validate = () => {
    combined.throwIfAborted();
    if (!db.prepare("SELECT 1 FROM mcp_work_leases WHERE token=? AND generation=? AND expires_at > ?").get(token, generation, now())) {
      throw new McpOperationError("CONFLICT", "任务执行租约已失效，请核对原任务状态");
    }
  };
  const heartbeat = setInterval(() => {
    try { mcpCleanupScope(() => inTransaction(() => {
      if (!db.prepare("UPDATE mcp_work_leases SET expires_at=? WHERE token=? AND generation=? AND expires_at > ?")
        .run(new Date(Date.now() + MCP_WORK_LEASE_MS).toISOString(), token, generation, now()).changes) {
        lost.abort(new McpOperationError("CONFLICT", "任务执行租约已失效"));
      }
    })); } catch { /* A busy database is retried next tick; the commit guard still checks expiry. */ }
  }, 5000);
  heartbeat.unref();
  try { return await withOperationGuard(validate, () => run(combined)); }
  finally {
    clearInterval(heartbeat);
    try { mcpCleanupScope(() => inTransaction(() => db.prepare("DELETE FROM mcp_work_leases WHERE token=?").run(token))); }
    catch { /* Expired leases are reaped by the next acquisition. */ }
  }
}
