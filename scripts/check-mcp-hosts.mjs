import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mcpPresets } from "../src/mcp/config.mjs";
import { readContext, readArtifact, waitForJob } from "../examples/mcp/helpers.mjs";

export const INSPECTOR_VERSION = "2.16.0";
export const TASKS_VERSION = "0.2.3";
export const SDK_VERSION = "2.4.0";
const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = path.join(root, "scripts/mcp.mjs");
const cache = path.join(root, ".test-artifacts/mcp-hosts/inspector-2.16.0");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

/** Child-only environment: no inherited model tokens, user catalogs or keychain writes. */
export function isolatedHostEnv(directory, parent = process.env) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"]) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return { ...env, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    APPDATA: directory, LOCALAPPDATA: directory, CODEX_HOME: directory,
    MCP_INSPECTOR_SECRET_STORE: "memory", MCP_INSPECTOR_STORAGE_DIR: directory,
    MCP_INSPECTOR_OAUTH_STATE_PATH: path.join(directory, "oauth.json"),
    RESUME_LIFE_DATA_DIR: path.join(directory, "data"), RESUME_LIFE_SETTINGS_KEY: "synthetic-host-compatibility-key",
    RESUME_LIFE_MCP_REPO_ROOTS: "[]", RESUME_LIFE_MCP_LLM_ENABLED: "false", RESUME_LIFE_MCP_WRITE_ENABLED: "false",
    RESUME_LIFE_MCP_TIMEOUT_MS: "30000", RESUME_LIFE_MCP_CACHE_TTL_HOURS: "168", RESUME_LIFE_MCP_CACHE_MAX_BYTES: "268435456" };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined>, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export async function runProcess(command, args, { cwd, env, timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    const stop = reason => {
      if (failure) return;
      failure = new Error(reason);
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
    };
    const timer = setTimeout(() => stop("Child process timed out"), timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) stop("Child stdout exceeded budget"); });
    child.stderr.on("data", chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 256 * 1024) stop("Child stderr exceeded budget"); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, stdout, stderr }); });
  });
}

export function supportsInspectorNode(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major === 24 && (minor > 22 || minor === 22 && patch >= 1)
    || major === 22 && (minor > 23 || minor === 23 && patch >= 4)
    || major === 26 && (minor > 12 || minor === 12 && patch >= 1) || major > 26;
}

export function inspectorResult(output, expectedExit = 0) {
  assert.equal(output.code, expectedExit, `Inspector exit code ${output.code}; ${output.stderr.slice(0, 2000)}`);
  const parsed = JSON.parse(output.stdout);
  assert.ok(parsed.result && typeof parsed.result === "object", "Inspector did not return a result envelope");
  return parsed.result;
}

export function toolData(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, true, "Missing structured success envelope");
  const text = result.content?.find(item => item.type === "text");
  if (text) assert.deepEqual(JSON.parse(text.text), result.structuredContent.data);
  return result.structuredContent.data;
}

export function assertToolError(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.ok, false);
  assert.equal(result.structuredContent.error.code, code);
  assert.equal(typeof result.structuredContent.meta.requestId, "string");
  assert.equal(typeof result.structuredContent.error.message, "string");
}

export function validateArtifactPage(part, artifact, offset) {
  assert.equal(part.offset, offset);
  assert.equal(part.artifactId, artifact.artifactId);
  assert.equal(part.byteLength, artifact.byteLength);
  assert.equal(part.sha256, artifact.sha256);
  assert.equal(part.encoding, "base64");
  assert.equal(typeof part.data, "string");
  const bytes = Buffer.from(part.data, "base64");
  assert.equal(bytes.toString("base64"), part.data);
  assert.ok(bytes.length > 0 && bytes.length <= 8000 && offset + bytes.length <= artifact.byteLength);
  assert.equal(part.nextOffset, offset + bytes.length === artifact.byteLength ? null : offset + bytes.length);
  return bytes;
}

async function connect(env, mode = "legacy", name = "compatibility-sdk-fixture") {
  const client = new Client({ name, version: "1" }, { versionNegotiation: { mode } });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], env, cwd: root, stderr: "ignore" }));
    return client;
  } catch (error) { await client.close(); throw error; }
}

/** Explicit wire-version probe, not a third Host. Uses the SDK only for stdio framing. */
export async function probeLegacyProtocol(env, version) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], cwd: root, env, stderr: "ignore" });
  const pending = new Map();
  let nextId = 0;
  transport.onmessage = message => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(`Wire error ${message.error.code}`)); else request.resolve(message.result);
  };
  const rejectAll = error => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  transport.onerror = rejectAll;
  transport.onclose = () => rejectAll(new Error("Wire transport closed"));
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Wire request timed out")); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    transport.send({ jsonrpc: "2.0", id, method, params }).catch(error => { pending.delete(id); clearTimeout(timer); reject(error); });
  });
  try {
    await transport.start();
    const initialized = await request("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "compatibility-wire-probe", version: "1" } });
    assert.equal(initialized.protocolVersion, version);
    assert.equal(initialized.capabilities.tasks, undefined);
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await request("tools/list");
    assert.ok(listed.tools.some(tool => tool.name === "get_mcp_status"));
    const result = toolData(await request("tools/call", { name: "get_mcp_status", arguments: {} }));
    return { client: "raw stdio probe (not an additional Host)", protocol: version, passed: true, workspaceBinding: result.workspaceBinding };
  } finally { rejectAll(new Error("Probe complete")); await transport.close(); }
}

async function fixture(env) {
  const client = await connect({ ...env, RESUME_LIFE_MCP_WRITE_ENABLED: "true", RESUME_LIFE_MCP_ALLOWED_TOOLS: mcpPresets.collaboration.tools.join(",") });
  const call = async (name, args) => toolData(await client.callTool({ name, arguments: args }));
  try {
    const resume = await call("create_resume_draft", { title: "Host compatibility synthetic resume", idempotencyKey: "hosts-resume-fixture" });
    const basis = await readContext(call, "get_resume_draft_context", { resumeId: resume.id });
    const proposal = { resumeId: resume.id, expectedRevision: basis.revision, modules: [
      { key: "basic", type: "basic", label: "基本信息", content: { name: "合成验收人物", phone: "13800138000", email: "compat@example.com", location: "测试城市", birthday: "", links: "" } },
      { key: "summary", type: "summary", label: "自我评价", content: { text: "合成兼容资料：参与本机数据工具维护。\n".repeat(450) } },
    ] };
    const preview = await readContext(call, "preview_resume_draft_edit", proposal, true);
    await call("save_resume_draft_edit", { ...proposal, previewToken: preview.previewToken, idempotencyKey: "hosts-resume-edit" });
    const source = { resumeId: resume.id };
    const context = await readContext(call, "get_resume_export_context", { source });
    assert.equal(context.value.canExport, true, "Synthetic export fixture has blocking issues");
    const exportArgs = { source, expectedRevision: context.revision, format: "markdown", idempotencyKey: "hosts-export-fixture" };
    const job = await call("start_mcp_job", { operation: "export_resume", arguments: exportArgs });
    const completed = await waitForJob(call, job.jobId);
    assert.equal(completed.job.status, "succeeded");
    const artifact = completed.result;
    const bytes = await readArtifact(call, artifact);
    assert.ok(bytes.length > 8000, "Fixture must exercise multiple artifact pages");
    return { resumeId: resume.id, artifact, jobId: job.jobId, exportArgs, bytes,
      workspaceBinding: (await call("get_mcp_status", {})).workspaceBinding };
  } finally { await client.close(); }
}

async function inspectorChecks({ inspectorNode, entry, directory, env, saved }) {
  const config = path.join(directory, "inspector.json");
  const readEnv = { ...env, RESUME_LIFE_MCP_ALLOWED_TOOLS: mcpPresets.readonly.tools.join(",") };
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { "resume-life": { command: process.execPath, args: [launcher], env: readEnv, cwd: root } } }), { mode: 0o600 });
  const initialConfigHash = digest(fs.readFileSync(config));
  const report = [];
  const invocations = [];
  for (const era of ["legacy", "modern"]) {
    try {
      const invoke = async (method, name, args = {}, expectedExit = 0) => {
        const argv = [entry, "--cli", "--config", config, "--server", "resume-life", "--protocol-era", era,
          "--format", "json", "--quiet", "--method", method, ...(name ? ["--tool-name", name, "--tool-args-json", JSON.stringify(args)] : [])];
        const output = await runProcess(inspectorNode, argv, { cwd: directory, env });
        invocations.push({ era, command: inspectorNode, args: argv, method, tool: name ?? null, exitCode: output.code });
        return inspectorResult(output, expectedExit);
      };
      const tools = (await invoke("tools/list")).tools;
      assert.deepEqual(tools.map(tool => tool.name).sort(), [...mcpPresets.readonly.tools].sort());
      assert.ok(tools.every(tool => tool.annotations?.readOnlyHint === true));
      const first = toolData(await invoke("tools/call", "get_mcp_status"));
      assert.equal(first.workspaceBinding, saved.workspaceBinding);
      assertToolError(await invoke("tools/call", "get_resume", { id: Number.MAX_SAFE_INTEGER }, 5), "NOT_FOUND");
      assertToolError(await invoke("tools/call", "get_resume", { id: -1 }, 5), "INVALID_ARGUMENT");
      const parts = [];
      let offset = 0;
      while (offset < saved.artifact.byteLength) {
        const part = toolData(await invoke("tools/call", "read_export_artifact", { artifactId: saved.artifact.artifactId, offset, length: 8000 }));
        const bytes = validateArtifactPage(part, saved.artifact, offset);
        parts.push(bytes); offset += bytes.length;
      }
      const bytes = Buffer.concat(parts);
      assert.equal(digest(bytes), saved.artifact.sha256);
      assert.deepEqual(bytes, saved.bytes);
      const afterRestart = toolData(await invoke("tools/call", "get_mcp_status"));
      assert.equal(afterRestart.workspaceBinding, saved.workspaceBinding);
      assert.equal(toolData(await invoke("tools/call", "get_mcp_job", { jobId: saved.jobId })).status, "succeeded");
      report.push({ era, passed: true, serverVersion: first.serverVersion, databaseVersion: first.databaseVersion,
        readToolCount: tools.length, errorCodes: ["NOT_FOUND", "INVALID_ARGUMENT"], artifactPages: parts.length,
        artifactBytes: bytes.length, artifactSha256: digest(bytes), restartedCalls: true, persistedJobRead: true });
    } catch (error) { report.push({ era, passed: false, error: error instanceof Error ? error.message : "Host check failed" }); }
  }
  assert.equal(digest(fs.readFileSync(config)), initialConfigHash, "Inspector modified its read-only config");
  assert.equal(fs.existsSync(path.join(directory, ".mcp-inspector/mcp.json")), false);
  return { package: "@modelcontextprotocol/inspector", version: INSPECTOR_VERSION, eras: report, invocations, configUnchanged: true };
}

async function sdkProtocolChecks(env, saved, tasksPackage) {
  const { createTaskSessionFromClient, resultFromTaskOutcome } = await import(pathToFileURL(path.join(tasksPackage, "dist/client/index.js")).href);
  const report = [];
  for (const mode of ["legacy", { pin: "2026-07-28" }]) {
    let client, session;
    try {
      client = await connect({ ...env, RESUME_LIFE_MCP_ALLOWED_TOOLS: mcpPresets.readonly.tools.join(",") }, mode, "compatibility-sdk-probe");
      const capabilities = client.getServerCapabilities();
      assert.equal(capabilities.tasks, undefined);
      assert.equal(capabilities.extensions?.["io.modelcontextprotocol/tasks"], undefined);
      const tools = (await client.listTools()).tools;
      assert.ok(tools.every(tool => tool.execution?.taskSupport === undefined || tool.execution.taskSupport === "forbidden"));
      session = createTaskSessionFromClient(client, { endpointId: saved.workspaceBinding });
      const execution = await session.callTool("get_mcp_status", {});
      const { outcome } = await execution.settle();
      assert.equal(execution.kind, "immediate");
      assert.equal(toolData(resultFromTaskOutcome(outcome)).workspaceBinding, saved.workspaceBinding);
      report.push({ client: "SDK probe (not an additional Host)", sdk: SDK_VERSION, passed: true, protocol: client.getNegotiatedProtocolVersion(),
        era: client.getProtocolEra(), tasksAdvertised: false, extTasksVersion: TASKS_VERSION, tasksRequesterFallback: "immediate" });
    } catch (error) { report.push({ client: "SDK probe (not an additional Host)", mode, passed: false, error: error instanceof Error ? error.message : "Protocol probe failed" }); }
    finally { await session?.close(); await client?.close(); }
  }
  const client = await connect({ ...env, RESUME_LIFE_MCP_WRITE_ENABLED: "true", RESUME_LIFE_MCP_ALLOWED_TOOLS: mcpPresets.collaboration.tools.join(",") });
  try {
    const replay = toolData(await client.callTool({ name: "start_mcp_job", arguments: { operation: "export_resume", arguments: saved.exportArgs } }));
    assert.equal(replay.jobId, saved.jobId);
    assert.equal(replay.status, "succeeded");
    const cancelled = toolData(await client.callTool({ name: "cancel_mcp_job", arguments: { jobId: saved.jobId } }));
    assert.equal(cancelled.status, "succeeded", "Completed domain job cancellation must preserve its result");
  } finally { await client.close(); }
  const legacyWire = [];
  for (const version of ["2024-11-05", "2025-03-26", "2025-06-18"]) {
    const result = await probeLegacyProtocol({ ...env, RESUME_LIFE_MCP_ALLOWED_TOOLS: "get_mcp_status" }, version);
    assert.equal(result.workspaceBinding, saved.workspaceBinding);
    legacyWire.push({ ...result, workspaceBinding: undefined });
  }
  return { probes: report, legacyWire, existingJobReplay: true, completedJobCancellationPreservesResult: true };
}

/** @param {{ inspectorRoot?: string, inspectorNode?: string }} [options] */
export async function checkMcpHosts({ inspectorRoot = cache, inspectorNode = process.execPath } = {}) {
  inspectorRoot = path.resolve(inspectorRoot);
  inspectorNode = path.resolve(inspectorNode);
  const inspectorPackage = path.join(inspectorRoot, "node_modules/@modelcontextprotocol/inspector");
  const tasksPackage = path.join(inspectorRoot, "node_modules/@modelcontextprotocol/ext-tasks");
  const pinnedPackages = [];
  const packages = [["inspector-cache", inspectorPackage, INSPECTOR_VERSION], ["inspector-cache", tasksPackage, TASKS_VERSION]];
  for (const [location, base] of [["project", root], ["inspector-cache", inspectorRoot]]) {
    for (const name of ["core", "client", "server"]) packages.push([location, path.join(base, "node_modules/@modelcontextprotocol", name), SDK_VERSION]);
  }
  for (const [location, folder, version] of packages) {
    const installed = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"));
    assert.equal(installed.version, version, `Pinned dependency differs: ${installed.name}; see docs/MCP-COMPATIBILITY.md`);
    pinnedPackages.push({ location, name: installed.name, version: installed.version });
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-hosts-"));
  try {
    const env = isolatedHostEnv(directory);
    const runtime = await runProcess(inspectorNode, ["-p", "process.versions.node"], { cwd: directory, env });
    assert.equal(runtime.code, 0);
    assert.ok(supportsInspectorNode(runtime.stdout.trim()),
      "Inspector 2.16.0 requires Node ^22.23.4 || ^24.22.1 || >=26.12.1; use --inspector-node with the cached runtime");
    const saved = await fixture(env);
    const inspector = await inspectorChecks({ inspectorNode, entry: path.join(inspectorPackage, "clients/launcher/build/index.js"), directory, env, saved });
    const sdk = await sdkProtocolChecks(env, saved, tasksPackage);
    return { ok: inspector.eras.every(era => era.passed) && sdk.probes.every(probe => probe.passed), checkedAt: new Date().toISOString(), platform: process.platform,
      arch: process.arch, osRelease: os.release(), serverNode: process.version, inspectorNode: runtime.stdout.trim(), pinnedPackages,
      invocation: { command: process.execPath, args: [fileURLToPath(import.meta.url), "--inspector-root", inspectorRoot, "--inspector-node", inspectorNode] },
      inspector, sdk, scope: { secondRealHost: "MCP Inspector CLI", additionalSdkHostCount: 0, syntheticDataOnly: true, remoteHttp: false,
        modelCalls: false, userSettingsModified: false, tasksAdapterImplemented: false } };
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("resume-life-hosts-"));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  let reportPath = path.join(root, ".test-artifacts/mcp-hosts/report.json");
  try {
    for (let i = 2; i < process.argv.length; i += 2) {
      const flag = process.argv[i], value = process.argv[i + 1];
      assert.ok(value && ["--inspector-root", "--inspector-node", "--report"].includes(flag), "Usage: node scripts/check-mcp-hosts.mjs [--inspector-root dir] [--inspector-node executable] [--report file]");
      if (flag === "--report") reportPath = path.resolve(value);
      else options[flag === "--inspector-root" ? "inspectorRoot" : "inspectorNode"] = path.resolve(value);
    }
    const result = await checkMcpHosts(options);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP Host check failed";
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ ok: false, checkedAt: new Date().toISOString(), platform: process.platform, error: message }, null, 2) + "\n");
    console.error(message); process.exitCode = 1;
  }
}
