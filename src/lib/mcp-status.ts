import { CURRENT_DB_VERSION, dataGeneration, getDb } from "./db";

/** 只返回运行状态计数；不读取或传输资料正文和模型凭证。 */
export function getMcpStatus() {
  const db = getDb();
  const drafts = db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(expires_at > ?),0) AS available FROM mcp_drafts").get(new Date().toISOString()) as { total: number; available: number };
  const requests = db.prepare("SELECT CASE WHEN status='pending' AND lease_expires_at <= ? THEN 'interrupted' ELSE status END AS status,COUNT(*) AS count FROM mcp_generation_requests WHERE generation=? GROUP BY 1")
    .all(new Date().toISOString(), dataGeneration() ?? "initial") as { status: string; count: number }[];
  const count = (status: string) => requests.find(row => row.status === status)?.count ?? 0;
  const logs = db.prepare("SELECT COUNT(*) AS count FROM mcp_operation_logs").get() as { count: number };
  return { databaseVersion: CURRENT_DB_VERSION, drafts: { total: drafts.total, available: drafts.available, expired: drafts.total - drafts.available },
    generationRequests: { pending: count("pending"), interrupted: count("interrupted"), succeeded: count("succeeded"), failed: count("failed") }, operationLogCount: logs.count };
}
