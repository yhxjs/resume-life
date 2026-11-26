import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildMcpConnectionConfig } from "./connection-config.mjs";
import { mcpPresets } from "./config.mjs";

const execute = promisify(execFile);
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-connection-")); });
afterEach(() => {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-connection-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("generated readonly configuration completes isolated stdio discovery and first call", async () => {
  const dataDirectory = path.join(directory, "data");
  const generated = buildMcpConnectionConfig({ projectRoot: process.cwd(), dataDirectory, preset: "readonly", env: {
    NODE_ENV: "test", RESUME_LIFE_MCP_ALLOWED_TOOLS: "get_mcp_status,create_project", RESUME_LIFE_SETTINGS_KEY: "PRIVATE_SENTINEL",
    ARBITRARY_SECRET: "PRIVATE_SENTINEL", RESUME_LIFE_MCP_LLM_ENABLED: "true",
  } });
  expect(generated.text).not.toContain("PRIVATE_SENTINEL");
  expect(generated.tools).toEqual(["get_mcp_status"]);
  const client = new Client({ name: "connection-isolated-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ ...generated.server, cwd: directory, stderr: "ignore" }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["get_mcp_status"]);
    const result = await client.callTool({ name: "get_mcp_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("databaseVersion");
    expect(fs.existsSync(path.join(dataDirectory, "resume-life.db"))).toBe(true);
  } finally { await client.close(); }
}, 30_000);

it.each(Object.keys(mcpPresets))("CLI and shared generator match for %s in both formats, preserving restrictions", async preset => {
  const env = { ...process.env, RESUME_LIFE_DATA_DIR: directory, RESUME_LIFE_MCP_ALLOWED_TOOLS: "get_mcp_status,create_project",
    RESUME_LIFE_MCP_REPO_ROOTS: JSON.stringify([directory]), RESUME_LIFE_SETTINGS_KEY: "PRIVATE_SENTINEL" };
  for (const format of ["json", "codex"]) {
    const result = await execute(process.execPath, [path.resolve("scripts/mcp.mjs"), "config", format, preset], { cwd: directory, env, timeout: 10_000 });
    const generated = buildMcpConnectionConfig({ projectRoot: process.cwd(), dataDirectory: directory, preset, format, env });
    expect(result.stdout.trim()).toBe(generated.text);
    expect(generated.tools.every(tool => ["get_mcp_status", "create_project"].includes(tool))).toBe(true);
    expect(generated.server.env.RESUME_LIFE_MCP_LLM_ENABLED).toBe("false");
    expect(result.stdout).not.toContain("PRIVATE_SENTINEL");
  }
});

it("empty allowlist stays empty; invalid or oversized paths and inherited object keys are rejected", () => {
  const options = { projectRoot: process.cwd(), dataDirectory: directory, preset: "readonly" };
  expect(buildMcpConnectionConfig({ ...options, env: { NODE_ENV: "test", RESUME_LIFE_MCP_ALLOWED_TOOLS: "" } }).tools).toEqual([]);
  for (const preset of ["__proto__", "constructor", "X".repeat(10000)]) expect(() => buildMcpConnectionConfig({ ...options, preset })).toThrow();
  for (const dataDirectory of ["relative", path.join(directory, "X".repeat(4096)), `${directory}\nsecret`]) {
    expect(() => buildMcpConnectionConfig({ ...options, dataDirectory })).toThrow();
  }
});
