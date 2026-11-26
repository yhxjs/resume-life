import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { openWorkflowStore } from "../../examples/mcp/workflow-store.mjs";
import { runWorkflow, WORKFLOW_WRITE_TOOLS } from "../../examples/mcp/workflow-runner.mjs";
import { toolAccess } from "./config.mjs";
import { ResumeLifeClient } from "../../examples/mcp/client.mjs";
import { importedResumePlan } from "../../examples/mcp/import-workflow.mjs";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-workflow-journal-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const plan = () => ({ id: "recover-flow-123", variables: { company: "测试公司" }, steps: [
  { id: "created", kind: "write", tool: "create_application", arguments: { company: "$input.company", role: "开发", stage: "interested" } },
  { id: "read", kind: "read", tool: "get_application", arguments: { id: "$steps.created.id" } },
] });

it("executes prototype-named steps and resumes their persisted results without repeating writes", async () => {
  const dataDirectory = path.join(directory, "data"), filename = path.join(directory, "journal.db");
  const names = Object.getOwnPropertyNames(Object.prototype).filter(name => !["__proto__", "constructor", "toString"].includes(name));
  const flow = { id: "prototype-step-recovery", steps: [
    { id: "toString", kind: "write", tool: "create_application", arguments: { company: "原型名称测试", role: "开发" } },
    ...names.map(id => ({ id, kind: "read", tool: "get_application", arguments: { id: "$steps.toString.id" } })),
  ] };
  let client = await ResumeLifeClient.connect({ dataDirectory, preset: "collaboration" });
  let store = openWorkflowStore(filename);
  try {
    await expect(client.runWorkflow(flow, { store, onCheckpoint: (checkpoint: { steps: Record<string, { status: string }> }) => {
      if (checkpoint.steps[flow.steps[0]!.id]?.status === "succeeded") throw new Error("stop after persisted write");
    } })).rejects.toThrow("stop after persisted write");
  } finally { store.close(); await client.close(); }
  client = await ResumeLifeClient.connect({ dataDirectory, preset: "collaboration" });
  store = openWorkflowStore(filename);
  const calls = vi.fn(client.call.bind(client));
  try {
    const result = await runWorkflow(calls, flow, { store });
    expect(result.status).toBe("succeeded");
    expect(result.results.toString).toEqual({ id: 1 });
    for (const name of names) expect(result.results[name]).toMatchObject({ application: { id: 1, company: "原型名称测试" } });
    expect(calls.mock.calls.some(([name]) => name === "create_application")).toBe(false);
    calls.mockClear();
    expect(await runWorkflow(calls, flow, { store })).toEqual(result);
    expect(calls.mock.calls.map(([name]) => name)).toEqual(["get_mcp_status"]);
    expect((await client.call("list_applications")).items).toHaveLength(1);
  } finally { store.close(); await client.close(); }
}, 30_000);

it("restarts an independent Agent after the server committed but before the result checkpoint", async () => {
  const dataDirectory = path.join(directory, "data"), journal = path.join(directory, "journal.db");
  const worker = path.join(directory, "agent.mjs");
  fs.writeFileSync(worker, `import {ResumeLifeClient} from ${JSON.stringify(pathToFileURL(path.resolve("examples/mcp/client.mjs")).href)};
    import {openWorkflowStore} from ${JSON.stringify(pathToFileURL(path.resolve("examples/mcp/workflow-store.mjs")).href)};
    import {runWorkflow} from ${JSON.stringify(pathToFileURL(path.resolve("examples/mcp/workflow-runner.mjs")).href)};
    const client=await ResumeLifeClient.connect(${JSON.stringify({ dataDirectory, preset: "collaboration" })});
    const store=openWorkflowStore(${JSON.stringify(journal)});
    await runWorkflow(async(name,args)=>{const value=await client.call(name,args);if(name==='create_application')process.exit(73);return value;},${JSON.stringify(plan())},{store});`);
  const process = spawn(globalThis.process.execPath, [worker], { stdio: "ignore", windowsHide: true });
  expect((await once(process, "exit"))[0]).toBe(73);
  const client = await ResumeLifeClient.connect({ dataDirectory, preset: "collaboration" });
  const store = openWorkflowStore(journal);
  try {
    const result = await runWorkflow(client.call.bind(client), plan(), { store });
    expect(result.results.created).toMatchObject({ id: 1 });
    expect(result.results.read).toMatchObject({ application: { company: "测试公司" } });
    const records = await client.call("list_applications"); expect(records.items).toHaveLength(1);
    expect(await runWorkflow(client.call.bind(client), plan(), { store })).toEqual(result);
    expect(store.list()).toMatchObject([{ status: "succeeded" }]);
    await expect(runWorkflow(client.call.bind(client), { ...plan(), variables: { company: "改变输入" } }, { store })).rejects.toMatchObject({ code: "CONFLICT" });
  } finally { await client.close(); store.close(); }
}, 30_000);

it.each([undefined, "4db8637d-47c7-4c63-b99e-30a0b30bfcd7"])("recovers a review committed before process exit with requestId=%s", async requestId => {
  const dataDirectory = path.join(directory, "data"), journal = path.join(directory, "review-journal.db");
  const seed = await ResumeLifeClient.connect({ dataDirectory, preset: "training" });
  try { await seed.call("get_mcp_status"); } finally { await seed.close(); }
  const db = new DatabaseSync(path.join(dataDirectory, "resume-life.db"));
  let client: ResumeLifeClient | undefined;
  let store: ReturnType<typeof openWorkflowStore> | undefined;
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO notebook_entries(id,source,source_id,question,created_at,updated_at) VALUES(1,'drill',1,'合成复习题',?,?)").run(new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO review_cards(id,notebook_id,next_review_date,created_at) VALUES(1,1,'2026-11-26',?)").run(new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    const flow = { id: "recover-review-flow", steps: [{ id: "reviewed", kind: "write", tool: "submit_review", arguments: {
      cardId: 1, answer: "合成复习回答", grade: "good", expectedReviewCount: 0, ...(requestId ? { requestId } : {}),
    } }] };
    const worker = path.join(directory, "review-agent.mjs");
    fs.writeFileSync(worker, `import {ResumeLifeClient} from ${JSON.stringify(pathToFileURL(path.resolve("examples/mcp/client.mjs")).href)};
      import {openWorkflowStore} from ${JSON.stringify(pathToFileURL(path.resolve("examples/mcp/workflow-store.mjs")).href)};
      import {runWorkflow} from ${JSON.stringify(pathToFileURL(path.resolve("examples/mcp/workflow-runner.mjs")).href)};
      const client=await ResumeLifeClient.connect(${JSON.stringify({ dataDirectory, preset: "training" })});
      const store=openWorkflowStore(${JSON.stringify(journal)});
      await runWorkflow(async(name,args)=>{const result=await client.call(name,args);if(name==='submit_review')process.exit(73);return result;},${JSON.stringify(flow)},{store});`);
    const workerProcess = spawn(process.execPath, [worker], { stdio: "ignore", windowsHide: true });
    expect((await once(workerProcess, "exit"))[0]).toBe(73);
    store = openWorkflowStore(journal);
    const owner = store.acquire(flow.id);
    let persistedRequestId: string;
    try {
      const checkpoint = owner.load().steps.reviewed;
      expect(checkpoint.status).toBe("pending");
      expect(checkpoint.arguments).not.toHaveProperty("idempotencyKey");
      persistedRequestId = checkpoint.arguments.requestId;
      expect(persistedRequestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      if (requestId) expect(persistedRequestId).toBe(requestId);
    } finally { owner.release(); }
    client = await ResumeLifeClient.connect({ dataDirectory, preset: "training" });
    const recovered = await client.runWorkflow(flow, { store });
    expect(recovered.results.reviewed).toMatchObject({ cardId: 1, requestId: persistedRequestId });
    expect(await client.runWorkflow(flow, { store })).toEqual(recovered);
    expect(db.prepare("SELECT request_id FROM review_attempts").all()).toEqual([{ request_id: persistedRequestId }]);
    expect(db.prepare("SELECT review_count FROM review_cards WHERE id=1").get()).toEqual({ review_count: 1 });
    expect(store.list()).toMatchObject([{ status: "succeeded" }]);
  } finally { await client?.close(); store?.close(); db.close(); }
}, 30_000);

it("keeps immutable inputs and result references through preview/save interruption", async () => {
  const dataDirectory = path.join(directory, "data"), client = await ResumeLifeClient.connect({ dataDirectory, preset: "collaboration" });
  const store = openWorkflowStore(path.join(directory, "journal.db"));
  const flow = { id: "resume-flow-123", steps: [
    { id: "created", kind: "write", tool: "create_resume_draft", arguments: { title: "原始草稿" } },
    { id: "source", kind: "context", tool: "get_resume_draft_context", arguments: { resumeId: "$steps.created.id" } },
    { id: "preview", kind: "preview", tool: "preview_resume_draft_edit", arguments: { resumeId: "$steps.created.id", expectedRevision: "$steps.source.revision", title: "流程保存", modules: [] } },
    { id: "saved", kind: "write", tool: "save_resume_draft_edit", arguments: { resumeId: "$steps.created.id", expectedRevision: "$steps.source.revision", title: "流程保存", modules: [], previewToken: "$steps.preview.previewToken" } },
  ] };
  try {
    await expect(runWorkflow(client.call.bind(client), flow, { store, onCheckpoint: async (checkpoint: { steps: Record<string, { status: string }> }) => {
      if (checkpoint.steps.preview?.status === "succeeded") throw new Error("simulate Agent exit");
    } })).rejects.toThrow("simulate Agent exit");
    const outcome = await runWorkflow(client.call.bind(client), flow, { store });
    expect(outcome.status).toBe("succeeded");
    expect((await client.call("get_resume", { id: (outcome.results.created as { id: number }).id })).resume.title).toBe("流程保存");
    const peerDirectory = path.join(directory, "other-data");
    const peer = await ResumeLifeClient.connect({ dataDirectory: peerDirectory, preset: "collaboration" });
    try { await expect(runWorkflow(peer.call.bind(peer), flow, { store })).rejects.toMatchObject({ code: "CONFLICT" }); }
    finally { await peer.close(); }
  } finally { await client.close(); store.close(); }
}, 30_000);

it("checks the workspace binding after automatic reconnect before replaying a write", async () => {
  const first = await ResumeLifeClient.connect({ dataDirectory: path.join(directory, "first"), preset: "collaboration" });
  const second = await ResumeLifeClient.connect({ dataDirectory: path.join(directory, "second"), preset: "collaboration" });
  const store = openWorkflowStore(path.join(directory, "journal.db"));
  let current = first, disconnected = false;
  const call = async (name: string, args?: object) => {
    const result = await current.call(name, args);
    if (name === "create_application" && !disconnected) {
      disconnected = true;
      throw Object.assign(new Error("lost response after commit"), { code: "ECONNRESET" });
    }
    return result;
  };
  try {
    await expect(runWorkflow(call, plan(), { store, reconnect: async () => { current = second; } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await first.call("list_applications")).items).toHaveLength(1);
    expect((await second.call("list_applications")).items).toHaveLength(0);
    expect(store.list()).toMatchObject([{ status: "needs_attention" }]);
    const recovered = await first.runWorkflow(plan(), { store });
    expect(recovered.results.created).toEqual({ id: 1 });
    expect((await first.call("list_applications")).items).toHaveLength(1);
  } finally { await first.close(); await second.close(); store.close(); }
}, 30_000);

it("marks argument binding failures as needs_attention while preserving completed writes", async () => {
  const client = await ResumeLifeClient.connect({ dataDirectory: path.join(directory, "data"), preset: "collaboration" });
  const store = openWorkflowStore(path.join(directory, "journal.db"));
  const flow = { ...plan(), steps: [...plan().steps, { id: "project", kind: "write", tool: "create_project", arguments: { name: "$input.missing" } }] };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.runWorkflow(flow, { store })).rejects.toThrow("工作流变量未提供");
      expect(store.list()).toMatchObject([{ status: "needs_attention" }]);
      expect((await client.call("list_applications")).items).toHaveLength(1);
      expect((await client.call("list_projects")).items).toHaveLength(0);
    }
  } finally { await client.close(); store.close(); }
}, 30_000);

it("rejects simultaneous owners and forbids an unreceipted write disguised as a read", async () => {
  const store = openWorkflowStore(path.join(directory, "journal.db")), second = openWorkflowStore(path.join(directory, "journal.db"));
  const owner = store.acquire("same-workflow");
  try {
    expect(() => second.acquire("same-workflow")).toThrow("其他进程");
    await expect(runWorkflow(vi.fn(), { id: "bad-flow-123", steps: [{ id: "save", kind: "read", tool: "create_application" }] }, { store })).rejects.toThrow("只读工具");
  } finally { owner.release(); second.close(); store.close(); }
});

it("rejects a write without a request receipt before earlier steps can create records", async () => {
  const client = await ResumeLifeClient.connect({ dataDirectory: path.join(directory, "data"), preset: "collaboration" });
  const store = openWorkflowStore(path.join(directory, "journal.db"));
  const flow = { ...plan(), steps: [...plan().steps, { id: "unreceipted", kind: "write", tool: "update_application", arguments: {
    id: "$steps.created.id", expectedRevision: "$steps.read.application.revision", notes: "should not execute",
  } }] };
  try {
    await expect(client.runWorkflow(flow, { store })).rejects.toThrow("回执");
    expect((await client.call("list_applications")).items).toHaveLength(0);
    expect(store.list()).toEqual([]);
  } finally { await client.close(); store.close(); }
}, 30_000);

it("matches replayable writes to the production discovery contracts", async () => {
  const client = await ResumeLifeClient.connect({ dataDirectory: path.join(directory, "data"), preset: "collaboration" });
  try {
    const discovered: Array<{ name: string; inputSchema: { required?: string[] } }> = (await client.client.listTools()).tools;
    const receipted = discovered.filter(tool => toolAccess[tool.name as keyof typeof toolAccess] === "write"
      && (tool.inputSchema.required?.includes("idempotencyKey") || tool.name === "submit_review" && tool.inputSchema.required?.includes("requestId")));
    expect([...WORKFLOW_WRITE_TOOLS].sort()).toEqual(receipted.map(tool => tool.name).sort());
  } finally { await client.close(); }
}, 30_000);

it("resumes upload, completed extraction job and committed import across three connection losses", async () => {
  const dataDirectory = path.join(directory, "data"), filename = path.join(directory, "journal.db");
  const flow = importedResumePlan({ id: "file-import-recovery", filename: "resume.txt", bytes: Buffer.from("姓名：示例人物\n参与 SQLite 项目。\n".repeat(2500)), result: { title: "可恢复导入", basic: { name: "示例人物" }, summary: { text: "参与 SQLite 项目。" } } });
  for (const tool of ["append_mcp_upload", "get_mcp_job_result", "save_file_import"]) {
    const client = await ResumeLifeClient.connect({ dataDirectory, preset: "collaboration" }), store = openWorkflowStore(filename);
    let interrupted = false;
    try {
      await expect(runWorkflow(async (name, args) => {
        const result = await client.call(name, args);
        if (name === tool && !interrupted) { interrupted = true; throw Object.assign(new Error("lost client after server response"), { code: "FORBIDDEN", retryable: false }); }
        return result;
      }, flow, { store, pollMs: 20 })).rejects.toThrow("lost client");
      expect(interrupted).toBe(true);
      expect(store.list()).toMatchObject([{ status: "needs_attention" }]);
    } finally { await client.close(); store.close(); }
  }
  const client = await ResumeLifeClient.connect({ dataDirectory, preset: "collaboration" }), store = openWorkflowStore(filename);
  try {
    const outcome = await client.runWorkflow(flow, { store });
    expect(outcome.status).toBe("succeeded");
    expect((await client.call("list_resumes")).items).toHaveLength(1);
    expect((await client.call("list_mcp_jobs")).items).toHaveLength(1);
    const journal = store.acquire(flow.id);
    try { expect(journal.load()).toMatchObject({ steps: { extracted: { jobId: expect.any(String), status: "succeeded" }, saved: { status: "succeeded", arguments: { idempotencyKey: expect.any(String), previewToken: expect.any(String) } } } }); }
    finally { journal.release(); }
  } finally { await client.close(); store.close(); }
}, 40_000);

it("retains conflicting preview inputs and never labels a stale save completed", async () => {
  const dataDirectory = path.join(directory, "data"), client = await ResumeLifeClient.connect({ dataDirectory, preset: "collaboration" });
  const store = openWorkflowStore(path.join(directory, "journal.db"));
  const flow = { id: "source-conflict-flow", steps: [
    { id: "created", kind: "write", tool: "create_resume_draft", arguments: { title: "原草稿" } },
    { id: "source", kind: "context", tool: "get_resume_draft_context", arguments: { resumeId: "$steps.created.id" } },
    { id: "preview", kind: "preview", tool: "preview_resume_draft_edit", arguments: { resumeId: "$steps.created.id", expectedRevision: "$steps.source.revision", title: "流程提案", modules: [] } },
    { id: "saved", kind: "write", tool: "save_resume_draft_edit", arguments: { resumeId: "$steps.created.id", expectedRevision: "$steps.source.revision", title: "流程提案", modules: [], previewToken: "$steps.preview.previewToken" } },
  ] };
  try {
    await expect(runWorkflow(client.call.bind(client), flow, { store, onCheckpoint: async checkpoint => { if (checkpoint.steps.preview?.status === "succeeded") throw new Error("stop after preview"); } })).rejects.toThrow("stop after preview");
    const source = await client.readContext("get_resume_draft_context", { resumeId: 1 });
    const input = { resumeId: 1, expectedRevision: source.revision, title: "另一 Agent 修改", modules: [] };
    const preview = await client.readContext("preview_resume_draft_edit", input, true);
    await client.call("save_resume_draft_edit", { ...input, previewToken: preview.previewToken, idempotencyKey: "peer-edited-once" });
    await expect(runWorkflow(client.call.bind(client), flow, { store })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await client.call("get_resume", { id: 1 })).resume.title).toBe("另一 Agent 修改");
    const checkpoint = store.acquire(flow.id);
    try { expect(checkpoint.load()).toMatchObject({ status: "needs_attention", steps: { saved: { status: "pending", error: { code: "CONFLICT" }, arguments: { title: "流程提案", expectedRevision: source.revision } } } }); }
    finally { checkpoint.release(); }
  } finally { await client.close(); store.close(); }
}, 30_000);
