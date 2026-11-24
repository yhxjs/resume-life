import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, expect, it } from "vitest";

const execute = promisify(execFile);
const launcher = path.resolve("scripts/mcp.mjs");
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-mcp-launcher-")); });
afterEach(() => {
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-mcp-launcher-")) throw new Error("Unsafe test path");
  fs.rmSync(directory, { recursive: true, force: true });
});

function launch(args: string[], env: Partial<NodeJS.ProcessEnv> = {}) {
  return execute(process.execPath, [launcher, ...args], { cwd: directory, timeout: 10_000, env: { ...process.env,
    RESUME_LIFE_DATA_DIR: path.join(directory, "new-data"), RESUME_LIFE_MCP_WRITE_ENABLED: "false", RESUME_LIFE_MCP_LLM_ENABLED: "false",
    RESUME_LIFE_SETTINGS_KEY: "TEST_PRIVATE_SETTINGS_KEY", ...env } });
}

it("runs doctor from a different directory without opening a database or revealing credentials", async () => {
  const result = await launch(["doctor"]);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, databaseExists: false, settingsKeyPresent: true, writeEnabled: false });
  expect(result.stdout + result.stderr).not.toContain("TEST_PRIVATE_SETTINGS_KEY");
  expect(fs.existsSync(path.join(directory, "new-data"))).toBe(false);
});

it("generates portable JSON and Codex configuration with the current executable", async () => {
  const json = JSON.parse((await launch(["config"])).stdout).mcpServers["resume-life"];
  expect(path.resolve(json.command)).toBe(path.resolve(process.execPath));
  expect(path.resolve(json.args[0])).toBe(launcher);
  expect(json.cwd).toBeUndefined();
  expect(json.env.RESUME_LIFE_MCP_WRITE_ENABLED).toBe("false");
  const toml = (await launch(["config", "codex"])).stdout;
  expect(toml).toContain("[mcp_servers.resume-life.env]");
  expect(toml).not.toContain("TEST_PRIVATE_SETTINGS_KEY");
});

it.each([
  ["get_application_stats, get_application_stats", ["get_application_stats"], "300001", 331],
  ["", [], "600000", 630],
] as const)("preserves allowlist %j and both deadlines even in an independent host", async (allowlist, names, timeout, clientSeconds) => {
  const env = { RESUME_LIFE_MCP_ALLOWED_TOOLS: allowlist, RESUME_LIFE_MCP_TIMEOUT_MS: timeout,
    RESUME_LIFE_MCP_WRITE_ENABLED: "true", RESUME_LIFE_MCP_LLM_ENABLED: "true" };
  const generated = JSON.parse((await launch(["config"], env)).stdout).mcpServers["resume-life"];
  expect(generated.env).toMatchObject({ RESUME_LIFE_MCP_ALLOWED_TOOLS: names.join(","), RESUME_LIFE_MCP_TIMEOUT_MS: timeout,
    RESUME_LIFE_MCP_WRITE_ENABLED: "false", RESUME_LIFE_MCP_LLM_ENABLED: "false" });
  expect(generated.env).not.toHaveProperty("RESUME_LIFE_SETTINGS_KEY");
  const toml = (await launch(["config", "codex"], env)).stdout;
  expect(toml).toContain(`RESUME_LIFE_MCP_ALLOWED_TOOLS = "${names.join(",")}"`);
  expect(toml).toContain(`RESUME_LIFE_MCP_TIMEOUT_MS = "${timeout}"`);
  expect(toml).toContain(`tool_timeout_sec = ${clientSeconds}\n`);
  const client = new Client({ name: "generated-config-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ ...generated, cwd: directory, stderr: "ignore" }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(names);
  } finally { await client.close(); }
}, 20_000);

it("fails early and clearly for an invalid directory or command", async () => {
  await expect(launch(["doctor"], { RESUME_LIFE_DATA_DIR: "relative/path" })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("绝对路径") });
  await expect(launch(["unknown"])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("用法") });
  const file = path.join(directory, "a-file"); fs.writeFileSync(file, "test");
  await expect(launch(["doctor"], { RESUME_LIFE_DATA_DIR: file })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("指向文件") });
});

it("rejects an unavailable root without looping", async () => {
  // Simulate an unavailable mount; probing real disconnected drives can itself block on Windows.
  const code = `import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
    const root = path.parse(process.cwd()).root;
    const data = path.join(root, '__mcp_unavailable_root__', 'data');
    const exists = fs.existsSync;
    const missing = new Set([data, path.dirname(data), root]);
    fs.existsSync = value => missing.has(path.resolve(String(value))) ? false : exists(value);
    process.env.RESUME_LIFE_DATA_DIR = data;
    const launcher = process.argv[1]; process.argv = [process.execPath, launcher, 'doctor'];
    await import(pathToFileURL(launcher).href);`;
  await expect(execute(process.execPath, ["--input-type=module", "--eval", code, launcher], { cwd: directory, timeout: 10_000 }))
    .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("根路径不可访问") });
});

for (const mode of ["doctor", "serve", "config"]) {
  it.each([
    [{ RESUME_LIFE_MCP_ALLOWED_TOOLS: "PRIVATE-UNKNOWN-NAME" }, "白名单"],
    [{ RESUME_LIFE_MCP_TIMEOUT_MS: "bad" }, "RESUME_LIFE_MCP_TIMEOUT_MS"],
  ] as const)(`${mode} rejects invalid MCP configuration before opening data or waiting for a handshake: %j`, async (env, hint) => {
    await expect(launch([mode], env)).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining(hint) });
    expect(fs.existsSync(path.join(directory, "new-data"))).toBe(false);
  });
}
