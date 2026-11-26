import { createHash, randomUUID } from "node:crypto";
import { dataGeneration, getDb, inTransaction, now } from "./db";
import { withDataGenerationScope } from "./data-generation";
import { classifyMcpError, McpOperationError } from "./mcp-errors";
import { OperationTimeoutError, withOperationGuard, withOperationLimits } from "./operation-deadline";
import { isMcpProcessAlive, mcpCleanupScope, MCP_WORK_LEASE_MS } from "./mcp-work-leases";
import { mcpContextPage, type ContextPageInput } from "./mcp-context";
import { pageParams } from "./mcp-read";
import { assertMcpCacheCapacity, assertMcpCacheFresh, mcpCachePolicy } from "./mcp-cache";
import { withMcpProgress, type McpProgress } from "./mcp-progress";

type JobStatus = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
type Job = { job_id: string; operation: string; request_key: string; input_hash: string; generation: string;
  payload_json: string | null; required_tools: string; status: JobStatus; owner_token: string; owner_pid: number;
  lease_expires_at: string; deadline_at: string; result_json: string | null; error_code: string | null; created_at: string; updated_at: string };
const active = new Map<string, AbortController>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expiry = () => new Date(Date.now() + MCP_WORK_LEASE_MS).toISOString();
const load = (id: string) => getDb().prepare("SELECT * FROM mcp_jobs WHERE job_id=?").get(id) as Job | undefined;

function resultCache(result: object, previousBytes: number): string | null {
  const text = JSON.stringify(result), bytes = Buffer.byteLength(text);
  // Job results are descriptors; large bodies remain in their own paged caches.
  if (bytes > 32_000) return null;
  try { assertMcpCacheCapacity(Math.max(0, bytes - previousBytes)); return text; }
  catch (error) {
    if (error instanceof McpOperationError && error.code === "BUSY") return null;
    throw error;
  }
}

function visible(row: Job) {
  const invalidated = row.generation !== (dataGeneration() ?? "initial");
  const progress = getDb().prepare("SELECT phase,completed,total,unit,updated_at AS updatedAt FROM mcp_job_progress WHERE job_id=?").get(row.job_id) as
    (McpProgress & { updatedAt: string }) | undefined;
  return { jobId: row.job_id, operation: row.operation, idempotencyKey: row.request_key,
    status: invalidated ? "invalidated" : row.status, errorCode: invalidated ? "CONFLICT" : row.error_code,
    resultAvailable: !invalidated && row.status === "succeeded" && row.result_json !== null && Date.parse(row.updated_at) + mcpCachePolicy().ttlHours * 3_600_000 > Date.now(),
    createdAt: row.created_at, updatedAt: row.updated_at, deadlineAt: row.deadline_at,
    progress: progress ?? null,
    elapsedMs: Math.max(0, (row.status === "running" && !invalidated ? Date.now() : Date.parse(row.updated_at)) - Date.parse(row.created_at)),
    lastHeartbeatAt: row.updated_at,
    result: { tool: "get_mcp_job_result", jobId: row.job_id } };
}

/** Lease/process checks never relaunch work. A committed receipt is recovered by the operation adapter. */
export function recoverMcpJob(id: string, recover?: (operation: string, key: string, payload: object) => object | undefined): Job {
  return inTransaction(() => {
    const row = load(id);
    if (!row) throw new McpOperationError("NOT_FOUND", "任务不存在");
    if (row.generation !== (dataGeneration() ?? "initial")) return row;
    if ((row.status === "running" || row.status === "interrupted") && row.payload_json && recover) {
      let result: object | undefined;
      try { result = recover(row.operation, row.request_key, JSON.parse(row.payload_json)); }
      catch (error) {
        // A committed receipt remains authoritative even after its reconstructible cache is gone.
        if (!(error instanceof McpOperationError) || error.code !== "NOT_FOUND" ||
          !getDb().prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool=? AND request_key=? AND generation=?").get(row.operation, row.request_key, row.generation)) throw error;
        getDb().prepare("UPDATE mcp_jobs SET status='succeeded',payload_json=NULL,result_json=NULL,error_code=NULL,updated_at=? WHERE job_id=?").run(now(), id);
        getDb().prepare("UPDATE mcp_job_progress SET phase='succeeded',updated_at=? WHERE job_id=?").run(now(), id);
        return load(id)!;
      }
      if (result) {
        getDb().prepare("UPDATE mcp_jobs SET status='succeeded',result_json=?,payload_json=NULL,error_code=NULL,updated_at=? WHERE job_id=?")
          .run(resultCache(result, Buffer.byteLength(row.payload_json)), now(), id);
        getDb().prepare("UPDATE mcp_job_progress SET phase='succeeded',updated_at=? WHERE job_id=?").run(now(), id);
        return load(id)!;
      }
    }
    if (row.status === "running" && row.deadline_at <= now()) {
      // A poll can beat the worker's timeout callback. Persist the same terminal
      // outcome here so clients never observe a transient interrupted/CANCELLED.
      getDb().prepare("UPDATE mcp_jobs SET status='failed',error_code='TIMEOUT',payload_json=NULL,updated_at=? WHERE job_id=?").run(now(), id);
      active.get(id)?.abort(new OperationTimeoutError());
      return load(id)!;
    }
    if (row.status === "running" && (row.lease_expires_at <= now() || !isMcpProcessAlive(row.owner_pid))) {
      getDb().prepare("UPDATE mcp_jobs SET status='interrupted',error_code='CANCELLED',updated_at=? WHERE job_id=?").run(now(), id);
      return load(id)!;
    }
    return row;
  });
}

type Recovery = Parameters<typeof recoverMcpJob>[1];
function authorized(id: string, permits: (tool: string) => boolean, recover?: Recovery) {
  const row = load(id);
  if (!row) throw new McpOperationError("NOT_FOUND", "任务不存在");
  if (!(JSON.parse(row.required_tools) as string[]).every(permits)) throw new McpOperationError("FORBIDDEN", "未获任务来源读取权限");
  return recoverMcpJob(id, recover);
}
export function getMcpJob(id: string, permits: (tool: string) => boolean, recover?: Recovery) { return visible(authorized(id, permits, recover)); }
export function getMcpJobResult(id: string, page: ContextPageInput, permits: (tool: string) => boolean, recover?: Recovery) {
  return inTransaction(() => {
    const row = authorized(id, permits, recover);
    if (row.generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "数据已恢复，旧任务结果失效");
    if (row.status === "running") throw new McpOperationError("BUSY", "任务仍在运行，请稍后查询");
    if (row.status !== "succeeded" || !row.result_json) throw new McpOperationError("NOT_FOUND", "任务无可用结果；请核对状态后使用新幂等键");
    assertMcpCacheFresh(row.updated_at);
    return mcpContextPage(JSON.parse(row.result_json), page);
  });
}
export function listMcpJobs(input: { cursor?: string; limit?: number }, permits: (tool: string) => boolean, recover?: Recovery) {
  const { limit, idCursor } = pageParams(input);
  // A numeric rowid cursor scans every row even when a page contains only unauthorized tasks.
  const rows = getDb().prepare("SELECT rowid AS id,* FROM mcp_jobs WHERE rowid < ? ORDER BY rowid DESC LIMIT ?")
    .all(idCursor ?? Number.MAX_SAFE_INTEGER, limit + 1) as (Job & { id: number })[];
  const selected = rows.slice(0, limit);
  return { items: selected.filter(row => (JSON.parse(row.required_tools) as string[]).every(permits))
    .map(row => visible(recoverMcpJob(row.job_id, recover))), nextCursor: rows.length > limit ? String(selected.at(-1)!.id) : null };
}
export function cancelMcpJob(id: string, permits: (tool: string) => boolean, recover?: Recovery) {
  return inTransaction(() => {
    const row = authorized(id, permits, recover);
    if (!permits(row.operation)) throw new McpOperationError("FORBIDDEN", "未获对应任务写权限");
    if (row.generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "数据已恢复，旧任务已失效");
    if (row.status === "running") {
      getDb().prepare("UPDATE mcp_jobs SET status='cancelled',error_code='CANCELLED',payload_json=NULL,updated_at=? WHERE job_id=?").run(now(), id);
      active.get(id)?.abort(new McpOperationError("CANCELLED", "任务已取消"));
    }
    return visible(load(id)!);
  });
}

export function startMcpJob(input: { operation: string; payload: Record<string, unknown>; requiredTools: string[]; timeoutMs: number },
  run: (signal: AbortSignal) => Promise<object>, recover?: Recovery) {
  const key = input.payload.idempotencyKey;
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new McpOperationError("INVALID_ARGUMENT", "任务参数需要原操作的幂等键");
  const id = hash([input.operation, key]), fingerprint = hash(input.payload), owner = randomUUID();
  const created = inTransaction(() => {
    const previous = load(id);
    if (previous) {
      if (previous.input_hash !== fingerprint || previous.generation !== (dataGeneration() ?? "initial")) throw new McpOperationError("CONFLICT", "任务幂等键属于其他参数或数据世代");
      return false;
    }
    const receipt = getDb().prepare("SELECT input_hash,generation FROM mcp_creation_receipts WHERE tool=? AND request_key=?")
      .get(input.operation, key) as { input_hash: string; generation: string } | undefined;
    const payload = { ...input.payload }; delete payload.idempotencyKey;
    if (receipt && (receipt.input_hash !== hash(payload) || receipt.generation !== (dataGeneration() ?? "initial"))) {
      throw new McpOperationError("CONFLICT", "原操作幂等键已用于不同参数或数据世代");
    }
    if ((getDb().prepare("SELECT COUNT(*) AS count FROM mcp_jobs WHERE status='running' AND lease_expires_at > ? AND generation=?")
      .get(now(), dataGeneration() ?? "initial") as { count: number }).count >= 8) throw new McpOperationError("BUSY", "运行中任务数量达到上限");
    const at = now();
    assertMcpCacheCapacity(Buffer.byteLength(JSON.stringify(input.payload)));
    getDb().prepare(`INSERT INTO mcp_jobs(job_id,operation,request_key,input_hash,generation,payload_json,required_tools,status,owner_token,owner_pid,lease_expires_at,deadline_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'running',?,?,?,?,?,?)`).run(id, input.operation, key, fingerprint, dataGeneration() ?? "initial", JSON.stringify(input.payload),
        JSON.stringify(input.requiredTools), owner, process.pid, expiry(), new Date(Date.now() + input.timeoutMs).toISOString(), at, at);
    getDb().prepare("INSERT INTO mcp_job_progress(job_id,phase,completed,total,unit,updated_at) VALUES(?,'starting',0,NULL,'steps',?)").run(id, at);
    return true;
  });
  if (created) {
    const generation = dataGeneration(), controller = new AbortController(); active.set(id, controller);
    // Separate request limits and generation scopes: transport disconnect is not task cancellation.
    setImmediate(() => { void execute(); });
    async function execute() {
      const database = mcpCleanupScope(() => getDb());
      const row = database.prepare("SELECT deadline_at,status FROM mcp_jobs WHERE job_id=?").get(id) as Job | undefined;
      if (!row || row.status !== "running") { active.delete(id); return; }
      const remainingMs = Math.max(0, Date.parse(row.deadline_at) - Date.now());
      const deadline = performance.now() + remainingMs;
      const timeout = setTimeout(() => controller.abort(new OperationTimeoutError()), remainingMs);
      const guard = () => {
        controller.signal.throwIfAborted();
        const row = database.prepare("SELECT * FROM mcp_jobs WHERE job_id=?").get(id) as Job | undefined;
        if (!row || row.owner_token !== owner || row.status !== "running" || row.lease_expires_at <= now()) throw new McpOperationError("CANCELLED", "任务已取消或执行权已失效");
        if (row.deadline_at <= now()) throw new OperationTimeoutError();
      };
      const heartbeat = setInterval(() => {
        try { mcpCleanupScope(() => inTransaction(() => {
          if (!getDb().prepare("UPDATE mcp_jobs SET lease_expires_at=?,updated_at=? WHERE job_id=? AND owner_token=? AND status='running' AND lease_expires_at > ?")
            .run(expiry(), now(), id, owner, now()).changes) controller.abort(new McpOperationError("CANCELLED", "任务执行权已失效"));
        })); } catch { /* Commit guard checks cancellation/expiry even if heartbeat cannot obtain the lock. */ }
      }, 5000);
      try {
        await withOperationLimits({ deadline, signal: controller.signal }, () => withDataGenerationScope(async () => {
          let lastPhase = "", lastReport = 0;
          const report = (progress: McpProgress) => {
            guard();
            if (!Number.isSafeInteger(progress.completed) || progress.completed < 0 || progress.total !== null && (!Number.isSafeInteger(progress.total) || progress.total < progress.completed)) throw new Error("Invalid task progress");
            if (lastPhase === progress.phase && Date.now() - lastReport < 100 && progress.completed !== progress.total) return;
            inTransaction(() => {
              getDb().prepare("UPDATE mcp_job_progress SET phase=?,completed=?,total=?,unit=?,updated_at=? WHERE job_id=?")
                .run(progress.phase, progress.completed, progress.total, progress.unit, now(), id);
            });
            lastPhase = progress.phase; lastReport = Date.now();
          };
          const result = await withMcpProgress(report, () => withOperationGuard(guard, () => run(controller.signal)));
          // The domain receipt is committed already; completion must not report a retroactive timeout.
          mcpCleanupScope(() => inTransaction(() => {
            if ((dataGeneration() ?? "initial") !== (generation ?? "initial")) return;
            const previous = load(id);
            if (!previous || previous.owner_token !== owner) return;
            getDb().prepare("UPDATE mcp_jobs SET status='succeeded',result_json=?,payload_json=NULL,error_code=NULL,updated_at=? WHERE job_id=? AND owner_token=?")
              .run(resultCache(result, Buffer.byteLength(previous.payload_json ?? "") + Buffer.byteLength(previous.result_json ?? "")), now(), id, owner);
            getDb().prepare("UPDATE mcp_job_progress SET phase='succeeded',updated_at=? WHERE job_id=?").run(now(), id);
          }));
        }, generation));
      } catch (error) {
        try { mcpCleanupScope(() => inTransaction(() => {
          const committed = recoverMcpJob(id, recover);
          if (committed.status === "succeeded") return;
          const code = classifyMcpError(error).code;
          getDb().prepare("UPDATE mcp_jobs SET status=?,error_code=?,payload_json=NULL,updated_at=? WHERE job_id=? AND owner_token=? AND generation=? AND status IN ('running','interrupted')")
            .run(code === "CANCELLED" ? "cancelled" : "failed", code, now(), id, owner, dataGeneration() ?? "initial");
        })); } catch { /* A later query recovers committed receipts or marks the expired lease interrupted. */ }
      } finally { clearTimeout(timeout); clearInterval(heartbeat); active.delete(id); }
    }
  }
  return visible(recoverMcpJob(id, recover));
}
