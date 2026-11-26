import { CURRENT_DB_VERSION, dataGeneration, getDb } from "./db";
import { mcpWorkspaceBinding } from "./mcp-runtime";
import { previewMcpCache } from "./mcp-cache";
import { isMcpProcessAlive } from "./mcp-work-leases";

/** 只返回运行状态计数；不读取或传输资料正文和模型凭证。 */
export function getMcpStatus(permits: (tool: string) => boolean = () => true) {
  const db = getDb();
  const drafts = db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(expires_at > ?),0) AS available FROM mcp_drafts").get(new Date().toISOString()) as { total: number; available: number };
  const requests = db.prepare("SELECT CASE WHEN status='pending' AND lease_expires_at <= ? THEN 'interrupted' ELSE status END AS status,COUNT(*) AS count FROM mcp_generation_requests WHERE generation=? GROUP BY 1")
    .all(new Date().toISOString(), dataGeneration() ?? "initial") as { status: string; count: number }[];
  const count = (status: string) => requests.find(row => row.status === status)?.count ?? 0;
  const logs = db.prepare("SELECT COUNT(*) AS count FROM mcp_operation_logs").get() as { count: number };
  const jobs = { running: 0, waiting: 0, interrupted: 0, succeeded: 0, failed: 0, cancelled: 0, invalidated: 0 };
  const at = new Date().toISOString(), generation = dataGeneration() ?? "initial";
  const tasks = db.prepare("SELECT j.status,j.required_tools,j.generation,j.owner_pid,j.lease_expires_at,j.deadline_at,p.phase FROM mcp_jobs j LEFT JOIN mcp_job_progress p ON p.job_id=j.job_id").iterate();
  for (const row of tasks) {
    if (!(JSON.parse(String(row.required_tools)) as string[]).every(permits)) continue;
    const state = row.generation !== generation ? "invalidated" : row.status === "running" && String(row.deadline_at) <= at ? "failed" : row.status === "running" &&
      (String(row.lease_expires_at) <= at || !isMcpProcessAlive(Number(row.owner_pid))) ? "interrupted" : String(row.status);
    if (Object.hasOwn(jobs, state)) jobs[state as keyof typeof jobs]++;
    if (state === "running" && row.phase === "waiting_resource") jobs.waiting++;
  }
  const leaseRows = db.prepare("SELECT resource,owner_pid FROM mcp_work_leases WHERE generation=? AND expires_at>?").all(generation, at) as { resource: "render" | "capture" | "parse"; owner_pid: number }[];
  const leases = (["render", "capture", "parse"] as const).map(resource => ({ resource, active: leaseRows.filter(row => row.resource === resource && isMcpProcessAlive(row.owner_pid)).length }));
  const cache = previewMcpCache(1);
  return { databaseVersion: CURRENT_DB_VERSION, workspaceBinding: mcpWorkspaceBinding(), drafts: { total: drafts.total, available: drafts.available, expired: drafts.total - drafts.available },
    jobs, leases, cache: { totalBytes: cache.totalBytes, maxBytes: cache.policy.maxBytes, ttlHours: cache.policy.ttlHours },
    generationRequests: { pending: count("pending"), interrupted: count("interrupted"), succeeded: count("succeeded"), failed: count("failed") }, operationLogCount: logs.count };
}
