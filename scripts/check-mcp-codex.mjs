import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mcpPresets, toolAccess } from "../src/mcp/config.mjs";
import { examplePortrait, runApplicationWorkflow } from "../examples/mcp/workflow.mjs";
import { resumeTrainingWorkflow, runTrainingWorkflow } from "../examples/mcp/training-workflow.mjs";
import { runAuthoringWorkflow, runExtendedTrainingWorkflow, resumeContentWorkflow, readContext } from "../examples/mcp/content-workflow.mjs";
import { runDeliveryWorkflow, resumeDeliveryWorkflow } from "../examples/mcp/delivery-workflow.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = path.join(root, "scripts/mcp.mjs");
const codex = process.env.RESUME_LIFE_CODEX_BIN || "codex";
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-codex-check-"));
const readTools = Object.keys(toolAccess).filter(name => toolAccess[name] === "read");
const env = { ...process.env, RESUME_LIFE_DATA_DIR: path.join(temporary, "data"), RESUME_LIFE_MCP_WRITE_ENABLED: "false",
  RESUME_LIFE_MCP_REPO_ROOTS: JSON.stringify([path.join(temporary, "repository")]),
  RESUME_LIFE_MCP_LLM_ENABLED: "false", RESUME_LIFE_MCP_ALLOWED_TOOLS: readTools.join(","), RESUME_LIFE_MCP_TIMEOUT_MS: "120000" };

async function configuration(format, allowed = readTools, preset) {
  return (await execute(process.execPath, [launcher, "config", format, ...(preset ? [preset] : [])], { cwd: temporary,
    env: { ...env, RESUME_LIFE_MCP_ALLOWED_TOOLS: allowed.join(",") }, timeout: 15_000, windowsHide: true })).stdout;
}

function toolData(result) {
  assert.equal(result.isError ?? false, false, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent?.ok, true);
  assert.deepEqual(result.structuredContent.data, JSON.parse(result.content.find(item => item.type === "text").text));
  return result.structuredContent.data;
}

function toolError(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.ok, false);
  assert.equal(result.structuredContent.error.code, code);
  assert.equal(typeof result.structuredContent.meta.requestId, "string");
}

async function startCodex(config, name) {
  const isolatedHome = path.join(temporary, name);
  fs.mkdirSync(isolatedHome);
  fs.writeFileSync(path.join(isolatedHome, "config.toml"), config, { mode: 0o600 });
  // Only this child sees the temporary configuration; the parent environment and client settings stay intact.
  const child = spawn(codex, ["app-server", "--stdio", "-c", 'model="mcp-smoke"', "-c", 'model_provider="mcp-smoke"',
    "-c", 'model_providers.mcp-smoke={name="MCP smoke",base_url="http://127.0.0.1:9/v1",wire_api="responses",requires_openai_auth=false}',
    "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "analytics.enabled=false"],
  { cwd: temporary, env: { ...process.env, CODEX_HOME: isolatedHome }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const lines = createInterface({ input: child.stdout });
  const rejectPending = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on("error", error => rejectPending(error));
  child.on("exit", code => { closed = true; rejectPending(new Error(`Codex app-server exited (${code})`)); });
  child.stderr.resume();
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { rejectPending(new Error("Codex stdout is not JSON-RPC")); return; }
    if (message.method && message.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "No interactive requests in the MCP smoke check" } }) + "\n");
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(`Codex ${item.method}: ${message.error.message}`));
    else item.resolve(message.result);
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Codex app-server is closed")); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 45_000);
    pending.set(id, { method, resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const stop = async () => {
    rejectPending(new Error("MCP smoke check finished")); lines.close();
    if (!closed) {
      if (process.platform === "win32") {
        await execute("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      } else { try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ } }
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (!closed) await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  };
  try {
    await rpc("initialize", { clientInfo: { name: "resume-life-mcp-smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const started = await rpc("thread/start", { cwd: temporary, ephemeral: true, approvalPolicy: "never" });
    const threadId = started.thread.id;
    const status = await rpc("mcpServerStatus/list", { threadId, serverName: "resume-life", limit: 10 });
    const server = status.data.find(item => item.name === "resume-life");
    assert.ok(server, "Codex did not discover resume-life");
    assert.equal(server.toolsError ?? null, null);
    return { tools: Object.values(server.tools), call: (tool, arguments_) => rpc("mcpServer/tool/call", { threadId, server: "resume-life", tool, arguments: arguments_ }), stop };
  } catch (error) { await stop(); throw error; }
}

async function main() {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(codex)) throw new Error("RESUME_LIFE_CODEX_BIN 需指向 codex.exe");
  const version = (await execute(codex, ["--version"], { timeout: 15_000, windowsHide: true })).stdout.trim();
  const generated = JSON.parse(await configuration("json")).mcpServers["resume-life"];
  const fixture = new Client({ name: "resume-life-smoke-fixture", version: "1" });
  let fixtureId;
  try {
    await fixture.connect(new StdioClientTransport({ ...generated, env: { ...generated.env, RESUME_LIFE_MCP_WRITE_ENABLED: "true", RESUME_LIFE_MCP_ALLOWED_TOOLS: "create_application" }, cwd: temporary, stderr: "ignore" }));
    fixtureId = toolData(await fixture.callTool({ name: "create_application", arguments: { company: "MCP 示例公司", role: "软件工程师", idempotencyKey: "codex-smoke-fixture" } })).id;
  } finally { await fixture.close(); }
  const trainingFixture = JSON.parse((await execute(process.execPath, [path.join(root, "scripts/check-mcp-training-fixture.mjs"), temporary],
    { cwd: temporary, env, timeout: 45_000, windowsHide: true })).stdout);
  const read = await startCodex(await configuration("codex"), "read-client");
  try {
    assert.deepEqual(read.tools.map(tool => tool.name).sort(), [...readTools].sort());
    assert.ok(read.tools.every(tool => tool.annotations?.readOnlyHint === true));
    assert.equal(toolData(await read.call("get_application", { id: fixtureId })).application.company, "MCP 示例公司");
  } finally { await read.stop(); }
  const allowed = ["create_application", "get_application", "list_applications"];
  const write = await startCodex((await configuration("codex", allowed)).replace('RESUME_LIFE_MCP_WRITE_ENABLED = "false"', 'RESUME_LIFE_MCP_WRITE_ENABLED = "true"'), "write-client");
  try {
    assert.deepEqual(write.tools.map(tool => tool.name).sort(), [...allowed].sort());
    const args = { company: "Codex 创建公司", role: "工程师", idempotencyKey: "codex-smoke-create" };
    const first = toolData(await write.call("create_application", args));
    assert.deepEqual(toolData(await write.call("create_application", args)), first);
    const page = toolData(await write.call("list_applications", { limit: 50 }));
    assert.equal(page.items.filter(item => item.company === args.company).length, 1);
  } finally { await write.stop(); }
  const collaboration = await configuration("codex", [...mcpPresets.collaboration.tools], "collaboration");
  const host = await startCodex(collaboration, "workflow-client");
  let result;
  let training;
  let authoring;
  let extended;
  let delivery;
  try {
    assert.deepEqual(host.tools.map(tool => tool.name).sort(), [...mcpPresets.collaboration.tools].sort());
    for (const tool of host.tools) assert.equal(tool.outputSchema?.oneOf?.length, 2, `${tool.name} output contract`);
    result = await runApplicationWorkflow(async (name, args) => toolData(await host.call(name, args)), { prefix: "codex-full-workflow" });
    training = await runTrainingWorkflow(async (name, args) => toolData(await host.call(name, args)), { ...trainingFixture, prefix: "codex-training" });
    authoring = await runAuthoringWorkflow(async (name, args) => toolData(await host.call(name, args)), { ...trainingFixture, prefix: "codex-authoring" });
    extended = await runExtendedTrainingWorkflow(async (name, args) => toolData(await host.call(name, args)), { ...trainingFixture, projectId: authoring.projectId, prefix: "codex-extended-training" });
    delivery = await runDeliveryWorkflow(async (name, args) => toolData(await host.call(name, args)), { resumeId: authoring.draftId, projectId: authoring.projectId, prefix: "codex-delivery" });
  } finally { await host.stop(); }
  const recovered = await startCodex(collaboration, "reconnected-client");
  try {
    await resumeTrainingWorkflow(async (name, args) => toolData(await recovered.call(name, args)), training);
    await resumeContentWorkflow(async (name, args) => toolData(await recovered.call(name, args)), authoring, extended);
    await resumeDeliveryWorkflow(async (name, args) => toolData(await recovered.call(name, args)), delivery);
    const applicationId = result.applicationId;
    const receipt = toolData(await recovered.call("get_ai_generation_request", { idempotencyKey: "codex-full-workflow:portrait" }));
    assert.equal(receipt.phase, "saved");
    assert.deepEqual(receipt.savedRecord, { id: result.portraitId, kind: "jd" });
    assert.equal(toolData(await recovered.call("get_jd_portrait", { id: result.portraitId })).result.role, examplePortrait.role);
    const staleRevision = toolData(await recovered.call("get_application", { id: applicationId })).application.revision;
    toolData(await recovered.call("update_application", { id: applicationId, expectedRevision: staleRevision, notes: "备份前已保存内容。" }));
    toolError(await recovered.call("update_application", { id: applicationId, expectedRevision: staleRevision, notes: "过期修改" }), "CONFLICT");
    const beforeRestore = toolData(await recovered.call("get_application", { id: applicationId })).application.revision;
    const source = toolData(await recovered.call("get_ai_workflow_context", { kind: "jd", applicationId }));
    const backup = JSON.parse((await execute(process.execPath, [path.join(root, "scripts/check-mcp-backup-fixture.mjs"), temporary, String(applicationId)],
      { cwd: temporary, env, timeout: 45_000, windowsHide: true })).stdout);
    assert.equal(backup.restored, true);
    toolError(await recovered.call("submit_practice_answer", training.answer), "CONFLICT");
    toolError(await recovered.call("answer_mock_interview", training.turn), "CONFLICT");
    for (const workflow of [authoring, extended]) for (const { name, args } of workflow.receipts) toolError(await recovered.call(name, args), "CONFLICT");
    for (const { name, args } of delivery.receipts) toolError(await recovered.call(name, args), "CONFLICT");
    for (const artifact of delivery.artifacts) toolError(await recovered.call("read_export_artifact", { artifactId: artifact.artifactId }), "CONFLICT");
    toolError(await recovered.call("get_bank_import_result", { idempotencyKey: delivery.bankKey }), "CONFLICT");
    toolError(await recovered.call("get_repository_capture", { idempotencyKey: delivery.captureKey }), "CONFLICT");
    assert.equal(toolData(await recovered.call("get_application", { id: delivery.applicationId })).application.resume_version_id, delivery.versionId);
    assert.equal((await readContext(async (name, args) => toolData(await recovered.call(name, args)), "get_career_record", { kind: "jargon_decoding", id: delivery.jargonId })).value.record.id, delivery.jargonId);
    assert.equal(toolData(await recovered.call("get_interview_series", { id: extended.seriesId })).status, "finished");
    assert.equal((await readContext(async (name, args) => toolData(await recovered.call(name, args)), "get_career_record", { kind: "salary_negotiation", id: extended.salaryId })).value.record.status, "finished");
    assert.equal(toolData(await recovered.call("get_interview", { id: training.mock.id })).interview.report.depth, 8.5);
    const invalidated = toolData(await recovered.call("get_ai_generation_request", { idempotencyKey: "codex-full-workflow:portrait" }));
    assert.equal(invalidated.phase, "invalidated");
    assert.equal(invalidated.draftAvailable, false);
    assert.equal(invalidated.savedRecord, null);
    toolError(await recovered.call("update_application", { id: applicationId, expectedRevision: beforeRestore, notes: "恢复前版本" }), "CONFLICT");
    toolError(await recovered.call("create_application", { company: "MCP 示例公司", role: "软件工程师", stage: "applied", jd: "维护本地 SQLite 数据库与工具集成。", idempotencyKey: "codex-full-workflow:application" }), "CONFLICT");
    toolError(await recovered.call("submit_ai_draft", { kind: "jd", applicationId, expectedSourceRevision: source.sourceRevision,
      idempotencyKey: "codex-after-restore-stale", result: examplePortrait }), "CONFLICT");
    assert.equal(toolData(await recovered.call("get_interview_review", { id: result.reviewId })).id, result.reviewId);
    const tasks = toolData(await recovered.call("list_preparation_tasks", { parentId: applicationId }));
    assert.ok(tasks.items.some(item => item.id === result.taskId && item.done));
    console.log(JSON.stringify({ ok: true, client: version, readTools: readTools.length, collaborationTools: host.tools.length,
      outsideProjectDirectory: true, structuredOutput: true, idempotentCreation: true, preparationPlan: true,
      interviewQuestions: true, externalDrafts: true, practiceReview: true, introEdit: true, projectMaterial: true, mockInterview: true,
      introCreation: true, projectSummary: true, generatedPractice: true, interviewTraining: true, interviewSeries: true, resumeDraft: true, careerTools: true,
      diagnosisAdoption: true, resumePublication: true, resumeFiles: true, resumeLayout: true, bankImport: true,
      notebookOrganization: true, repositoryEvidence: true, jargonDecoding: true, portfolioExport: true,
      reconnect: true, revisionConflict: true, backupRestore: backup }, null, 2));
  } finally { await recovered.stop(); }
}

try { await main(); }
catch (error) { console.error(`[mcp:codex] ${error instanceof Error ? error.message : "检查失败"}`); process.exitCode = 1; }
finally {
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("resume-life-codex-check-")) throw new Error("Unsafe smoke cleanup path");
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
