import { createHash } from "node:crypto";
import { dataGeneration, getDb } from "./db";

/** Stable within this database instance and generation, never a credential or a local path. */
export function mcpWorkspaceBinding(): string {
  const db = getDb();
  const row = db.prepare("SELECT instance_id FROM mcp_runtime_identity WHERE id=1").get() as { instance_id: string } | undefined;
  if (!row) throw new Error("MCP runtime identity is missing");
  return createHash("sha256").update(JSON.stringify([row.instance_id, dataGeneration(db)])).digest("hex");
}
