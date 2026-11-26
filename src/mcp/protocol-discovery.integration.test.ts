import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

it.each([
  { mode: "legacy" as const, version: "2025-11-25" },
  { mode: { pin: "2026-07-28" }, version: "2026-07-28" },
])("discovers the production stdio entry using $version and validates structured results", async ({ mode, version }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-protocol-"));
  const client = new Client({ name: "protocol-regression", version: "1" }, { versionNegotiation: { mode } });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("scripts/mcp.mjs")], cwd: directory, stderr: "pipe",
      env: { RESUME_LIFE_DATA_DIR: path.join(directory, "data"), RESUME_LIFE_MCP_ALLOWED_TOOLS: "get_mcp_status,preview_application_rebase,get_application",
        RESUME_LIFE_MCP_WRITE_ENABLED: "false", RESUME_LIFE_MCP_LLM_ENABLED: "false" } }));
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name).sort()).toEqual(["get_application", "get_mcp_status", "preview_application_rebase"]);
    expect(tools.find(tool => tool.name === "preview_application_rebase")?.inputSchema.properties).toHaveProperty("mode");
    const result = await client.callTool({ name: "get_mcp_status", arguments: {} });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { databaseVersion: 14, workspaceBinding: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const invalid = await client.callTool({ name: "preview_application_rebase", arguments: { mode: "capture", applicationId: 1 } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" }, meta: { requestId: expect.any(String) } });
  } finally {
    await client.close();
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-protocol-")) throw new Error("Unsafe protocol fixture cleanup");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
