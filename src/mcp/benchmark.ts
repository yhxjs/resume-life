import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createApplication, getApplicationById } from "@/lib/applications";
import { getDb, inTransaction, now, requestDataGeneration } from "@/lib/db";
import { createSession, initializeCredentials, SESSION_COOKIE_NAME } from "@/lib/auth";
import { DATA_GENERATION_HEADER, INITIAL_DATA_GENERATION } from "@/lib/data-generation-contract";
import { PATCH as patchApplication } from "@/app/api/applications/[id]/route";

function data<T>(result: CallToolResult): T {
  assert.equal(result.isError ?? false, false);
  const envelope = result.structuredContent as { ok: boolean; data: T } | undefined;
  assert.equal(envelope?.ok, true);
  return envelope!.data;
}
function percentiles(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const value = (p: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(2));
  return { samples: samples.length, p50Ms: value(0.5), p95Ms: value(0.95), maxMs: value(1) };
}

/** Synthetic fixtures only. The Web route and a real stdio process concurrently use the same temporary SQLite file. */
export async function benchmarkMcp(temporary: string) {
  const db = getDb();
  const client = new Client({ name: "resume-life-mcp-benchmark", version: "1" });
  try {
    const app = createApplication({ company: "并发测试公司", role: "开发" });
    initializeCredentials("benchmark-user", "benchmark-only-password");
    const session = createSession();
    const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${session.token}`, "sec-fetch-site": "same-origin",
      [DATA_GENERATION_HEADER]: requestDataGeneration() ?? INITIAL_DATA_GENERATION };
    const content = "技术材料：接口、事务、验证与恢复🙂\n".repeat(32_000);
    let materialId = 0;
    const queryRequestId = randomUUID();
    inTransaction(() => {
      const timestamp = now();
      const project = db.prepare("INSERT INTO projects (name,summary,created_at,updated_at) VALUES (?,?,?,?)").run("性能测试项目", '{"brief":"测试","achievements":[]}', timestamp, timestamp);
      materialId = Number(db.prepare("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (?,?,?,?)").run(Number(project.lastInsertRowid), "长材料", content, timestamp).lastInsertRowid);
      const insert = db.prepare("INSERT INTO mcp_operation_logs (request_id,tool,target_id,status,error_code,duration_ms,created_at) VALUES (?,?,?,?,?,?,?)");
      for (let i = 1; i <= 5000; i++) insert.run(i === 2500 ? queryRequestId : randomUUID(), "get_application", app.id, i % 10 === 0 ? "error" : "success", i % 10 === 0 ? "NOT_FOUND" : null, 1, timestamp);
    });
    const startup = performance.now();
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL("../../scripts/mcp.mjs", import.meta.url))], cwd: temporary, stderr: "ignore",
      env: { RESUME_LIFE_DATA_DIR: path.join(temporary, "data"), RESUME_LIFE_MCP_WRITE_ENABLED: "false", RESUME_LIFE_MCP_LLM_ENABLED: "false",
        RESUME_LIFE_MCP_ALLOWED_TOOLS: "get_application,list_applications,list_project_materials,read_record_section,list_mcp_operations" } }));
    const startupMs = performance.now() - startup;
    const parts: string[] = []; const readTimes: number[] = [];
    let revision: string | undefined; let offset = 0; let sectionsDuringWebWrites = 0; let writesFinished = false;
    const started = performance.now();
    const writer = (async () => {
      try {
        for (let i = 1; i <= 100; i++) {
          const response = await patchApplication(new Request(`http://localhost/api/applications/${app.id}`, { method: "PATCH", headers, body: JSON.stringify({ notes: `网页并发修改 ${i}` }) }), { params: Promise.resolve({ id: String(app.id) }) });
          assert.equal(response.status, 200);
          await pause(2);
        }
      } finally { writesFinished = true; }
    })();
    const reader = (async () => {
      while (true) {
        const start = performance.now();
        const section = data<{ text: string; revision: string; nextOffset: number | null }>(await client.callTool({ name: "read_record_section", arguments: { kind: "project_material", id: materialId, offset, expectedRevision: revision } }));
        readTimes.push(performance.now() - start); parts.push(section.text); revision = section.revision;
        if (!writesFinished) sectionsDuringWebWrites++;
        if (section.nextOffset === null) return;
        offset = section.nextOffset;
      }
    })();
    const outcomes = await Promise.allSettled([writer, reader]);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    assert.ok(sectionsDuringWebWrites > 0, "Concurrent readers and Web writes did not overlap");
    assert.equal(JSON.parse(parts.join("")).content, content);
    assert.equal(getApplicationById(app.id)?.notes, "网页并发修改 100");
    const concurrentDurationMs = performance.now() - started;
    const logTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const logs = data<{ items: { request_id: string }[] }>(await client.callTool({ name: "list_mcp_operations", arguments: { requestId: queryRequestId, tool: "get_application", errorCode: "NOT_FOUND", limit: 1 } }));
      logTimes.push(performance.now() - start); assert.equal(logs.items[0]?.request_id, queryRequestId);
    }
    return { ok: true, measuredAt: now(), node: process.version, platform: process.platform, startupMs: Number(startupMs.toFixed(2)),
      longRecord: { utf16Length: content.length, ...percentiles(readTimes), fullyReassembled: true },
      concurrency: { webRouteWrites: 100, sectionsDuringWebWrites, durationMs: Number(concurrentDurationMs.toFixed(2)), finalWebStateVerified: true },
      operationLookup: { retainedRows: (db.prepare("SELECT COUNT(*) AS n FROM mcp_operation_logs").get() as { n: number }).n, ...percentiles(logTimes) } };
  } finally { await client.close(); db.close(); }
}
