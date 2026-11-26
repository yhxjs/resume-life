import type { DatabaseSync } from "node:sqlite";

/** Model an actual pre-v14 database, including absence of its local runtime triggers. */
export function dropMcpRuntimeV14(db: DatabaseSync) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'mcp_search_epoch_*'").all() as { name: string }[]) {
    db.exec('DROP TRIGGER "' + row.name.replaceAll('"', '""') + '"');
  }
  db.exec("DROP TABLE IF EXISTS mcp_job_progress; DROP TABLE IF EXISTS mcp_search_epochs; DROP TABLE IF EXISTS mcp_runtime_identity");
}
