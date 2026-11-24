import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

let directory: string;
let db: import("node:sqlite").DatabaseSync;
let server: import("@modelcontextprotocol/server").McpServer;
let client: Client;
const model = { role: "开发", must_skills: [{ name: "TypeScript", weight: 8, why: "JD 提及" }], followups: [], company_style: { style: "未知", signals: [] } };
type Draft = { draftId: number; sourceRevision: string; idempotencyKey: string; saved: boolean; expiresAt: string; result: object };

async function connect(write = false, llm = false) {
  await client?.close(); await server?.close();
  vi.stubEnv("RESUME_LIFE_MCP_WRITE_ENABLED", String(write)); vi.stubEnv("RESUME_LIFE_MCP_LLM_ENABLED", String(llm));
  server = (await import("./server")).createResumeLifeMcpServer();
  client = new Client({ name: "workflow-recovery-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-workflow-recovery-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  vi.stubEnv("RESUME_LIFE_MCP_ALLOWED_TOOLS", undefined); vi.stubEnv("RESUME_LIFE_MCP_TIMEOUT_MS", undefined);
  db = (await import("@/lib/db")).getDb();
  (await import("@/lib/applications")).createApplication({ company: "恢复测试公司", role: "工程师", jd: "需要 TypeScript" });
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); db?.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-workflow-recovery-")) throw new Error("Unsafe test cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
function data<T = Record<string, unknown>>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  const text = result.content.find(item => item.type === "text");
  if (text?.type !== "text") throw new Error("Missing tool text");
  const parsed = JSON.parse(text.text);
  expect(result.structuredContent).toMatchObject({ ok: true, data: parsed });
  return parsed as T;
}
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
const application = async () => data<{ application: { revision: string } }>(await call("get_application", { id: 1 })).application;
const generate = (idempotencyKey: string) => call("analyze_application_jd", { applicationId: 1, idempotencyKey });
const status = (idempotencyKey: string) => call("get_ai_generation_request", { idempotencyKey });

it("declares core data fields and preserves legacy fields in structured output", async () => {
  const tools = (await client.listTools()).tools;
  for (const [name, fields] of [["get_application", ["application", "interviewRounds", "customTasks"]], ["list_applications", ["items", "nextCursor"]],
    ["read_record_section", ["revision", "encoding", "offset", "nextOffset", "text"]], ["get_ai_draft", ["id", "payload", "saved", "expires_at"]],
    ["get_ai_generation_request", ["idempotencyKey", "status", "draftAvailable", "savedRecord"]]] as const) {
    const schema = tools.find(tool => tool.name === name)!.outputSchema as { properties: { data: { properties: object } } };
    expect(Object.keys(schema.properties.data.properties)).toEqual(expect.arrayContaining([...fields]));
  }
  const app = data<{ application: { notes: string; salary_range: string; revision: string } }>(await call("get_application", { id: 1 }));
  expect(app.application.salary_range).toBe(""); expect(app.application.notes).toBe(""); expect(app.application.revision).toHaveLength(64);
  expect((await call("get_application", { id: 999 })).structuredContent).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

it.each([
  ["list_applications", "applications", "company,role,stage", "'历史投递','工程师','interested'"],
  ["list_resumes", "resumes", "title", "'历史简历'"],
  ["list_projects", "projects", "name", "'历史项目'"],
] as const)("preserves restored safe-integer IDs in %s output", async (tool, table, columns, values) => {
  const timestamp = new Date().toISOString();
  for (const restoredId of [0, -1]) {
    db.prepare(`INSERT INTO ${table} (id,${columns},created_at,updated_at) VALUES (?,${values},?,?)`).run(restoredId, timestamp, timestamp);
  }
  const result = data<{ items: { id: number }[] }>(await call(tool));
  expect(result.items.map(item => item.id)).toEqual(expect.arrayContaining([0, -1]));
});

it.each([0, -1])("preserves restored child ID %s in application and collection output", async restoredId => {
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO application_preparation_tasks (id,application_id,title,created_at) VALUES (?,1,'历史待办',?)").run(restoredId, timestamp);
  db.prepare("INSERT INTO application_interviews (id,application_id,round_name,created_at,updated_at) VALUES (?,1,'历史面试',?,?)").run(restoredId, timestamp, timestamp);
  const result = data<{ customTasks: { id: number }[]; interviewRounds: { id: number }[] }>(await call("get_application", { id: 1 }));
  expect(result.customTasks[0]?.id).toBe(restoredId);
  expect(result.interviewRounds[0]?.id).toBe(restoredId);
  for (const tool of ["list_preparation_tasks", "list_application_interviews"]) {
    expect(data<{ items: { id: number }[] }>(await call(tool, { parentId: 1 })).items[0]?.id).toBe(restoredId);
  }
});

it("advertises replacements as destructive and creation and draft saves as additive", async () => {
  await connect(true);
  const tools = (await client.listTools()).tools;
  for (const name of ["update_application", "set_preparation_step", "generate_preparation_plan", "update_preparation_task",
    "reschedule_application_interview", "save_application_interview_questions"]) {
    expect(tools.find(tool => tool.name === name)?.annotations, name)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  }
  for (const name of ["create_application", "create_preparation_task", "schedule_application_interview", "save_ai_draft"]) {
    expect(tools.find(tool => tool.name === name)?.annotations, name)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  }
});

it("completes and reopens tasks through shared Web validation and rejects a stale Web edit", async () => {
  await connect(true);
  const task = (await import("@/lib/application-preparation")).createPreparationTask(1, "准备材料");
  const initial = await application();
  expect(data(await call("update_preparation_task", { applicationId: 1, taskId: task.id, expectedRevision: initial.revision, done: true }))).toEqual({ id: task.id });
  expect((await import("@/lib/application-preparation")).listPreparationTasks(1)[0]?.done).toBe(true);
  const old = await application();
  const route = await import("@/app/api/applications/[id]/preparation/tasks/route");
  const edited = await route.PATCH(new Request("http://localhost/api/applications/1/preparation/tasks", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: task.id, title: "网页更新材料" }) }), { params: Promise.resolve({ id: "1" }) });
  expect(edited.status).toBe(200);
  expect((await call("update_preparation_task", { applicationId: 1, taskId: task.id, expectedRevision: old.revision, done: false })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  data(await call("update_preparation_task", { applicationId: 1, taskId: task.id, expectedRevision: (await application()).revision, done: false, dueTime: "2026-12-01T10:00:00+08:00" }));
  expect((await import("@/lib/application-preparation")).listPreparationTasks(1)[0]).toMatchObject({ title: "网页更新材料", done: false, due_time: "2026-12-01T02:00:00.000Z" });
});

it("checks task ownership and time validity without committing any edits", async () => {
  await connect(true);
  const second = (await import("@/lib/applications")).createApplication({ company: "其他公司", role: "开发" });
  const prep = await import("@/lib/application-preparation");
  const foreign = prep.createPreparationTask(second.id, "其他待办");
  expect((await call("update_preparation_task", { applicationId: 1, taskId: foreign.id, expectedRevision: (await application()).revision, done: true })).structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
  const task = prep.createPreparationTask(1, "本投递待办");
  expect((await call("update_preparation_task", { applicationId: 1, taskId: task.id, expectedRevision: (await application()).revision, done: true, dueTime: "2026-11-31T10:00:00+08:00" })).structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  expect(prep.listPreparationTasks(1)[0]?.done).toBe(false); expect(prep.listPreparationTasks(second.id)[0]?.done).toBe(false);
});

it("reschedules a real interview, synchronizes the next interview and detects Web changes", async () => {
  await connect(true);
  const apps = await import("@/lib/applications");
  const round = apps.createApplicationInterview(1, { round_name: "技术面", interview_time: "2026-12-01T10:00:00+08:00" });
  data(await call("reschedule_application_interview", { applicationId: 1, interviewId: round.id, expectedRevision: (await application()).revision, interview_time: "2026-12-02T14:00:00+08:00" }));
  expect(apps.getApplicationById(1)?.next_interview_at).toBe("2026-12-02T06:00:00.000Z");
  expect(apps.getApplicationInterviewById(round.id)?.interview_time).toBe("2026-12-02T06:00:00.000Z");
  const before = await application();
  apps.updateApplicationInterview(round.id, { round_name: "网页更名" });
  expect((await call("reschedule_application_interview", { applicationId: 1, interviewId: round.id, expectedRevision: before.revision, interview_time: "2026-12-03T14:00:00+08:00" })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
});

it("generates and refreshes plans, preserves completion and requires current plan and context", async () => {
  await connect(true);
  type Plan = { revision: string; contextKey: string; stale: boolean; generatedAt: string | null; steps: { key: string; done: boolean }[] };
  const readPlan = async () => data<Plan>(await call("get_preparation_plan", { applicationId: 1 }));
  const initial = await readPlan(); expect(initial.generatedAt).toBeNull();
  const first = data<Plan>(await call("generate_preparation_plan", { applicationId: 1, expectedRevision: initial.revision, contextKey: initial.contextKey }));
  expect(first.steps.length).toBeGreaterThan(0);
  data(await call("set_preparation_step", { applicationId: 1, expectedRevision: first.revision, contextKey: first.contextKey, key: "questions", done: true }));
  expect((await call("generate_preparation_plan", { applicationId: 1, expectedRevision: first.revision, contextKey: first.contextKey })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  const completed = await readPlan();
  const refreshed = data<Plan>(await call("generate_preparation_plan", { applicationId: 1, expectedRevision: completed.revision, contextKey: completed.contextKey }));
  expect(refreshed.steps.find(step => step.key === "questions")?.done).toBe(true);
  (await import("@/lib/applications")).updateApplication(1, { jd: "岗位 JD 更新" });
  expect((await call("generate_preparation_plan", { applicationId: 1, expectedRevision: refreshed.revision, contextKey: refreshed.contextKey })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  const changed = await readPlan();
  const rebuilt = data<Plan>(await call("generate_preparation_plan", { applicationId: 1, expectedRevision: changed.revision, contextKey: changed.contextKey }));
  expect(rebuilt.steps.find(step => step.key === "questions")?.done).toBe(false);
});

it("advertises destructive question replacement, saves and clears questions, and refuses Web edits and restored tokens", async () => {
  await connect(true);
  const tool = (await client.listTools()).tools.find(tool => tool.name === "save_application_interview_questions");
  expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-24T01:00:00.000Z"));
  const round = (await import("@/lib/applications")).createApplicationInterview(1, { round_name: "技术面" });
  const args = { applicationId: 1, interviewId: round.id };
  type Questions = { revision: string; inputHash: string; questions: object[] };
  const read = async () => data<Questions>(await call("get_application_interview_questions", args));
  const before = await read();
  data(await call("save_application_interview_questions", { ...args, expectedRevision: before.revision, questions: [{ question: "项目如何验证？", answer: "集成测试" }] }));
  const current = await read();
  const reviews = await import("@/lib/application-interview-review");
  expect(reviews.getInterviewReview(1, round.id).questions).toEqual(current.questions);
  reviews.saveInterviewQuestions(1, round.id, [{ question: "网页补充的提问", answer: "网页回答" }], current.inputHash);
  expect((await call("save_application_interview_questions", { ...args, expectedRevision: current.revision, questions: [] })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  const fresh = await read();
  db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation").run("restored-question-data");
  expect((await call("save_application_interview_questions", { ...args, expectedRevision: fresh.revision, questions: [] })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  const restored = await read();
  data(await call("save_application_interview_questions", { ...args, expectedRevision: restored.revision, questions: [] }));
  expect((await read()).questions).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM application_interview_questions WHERE interview_id=?").get(round.id)).toEqual({ n: 0 });
});

it("offers full reading for truncated questions and gates it with the corresponding read capability", async () => {
  await connect(true);
  const round = (await import("@/lib/applications")).createApplicationInterview(1, { round_name: "技术面" });
  const args = { applicationId: 1, interviewId: round.id };
  const initial = data<{ revision: string }>(await call("get_application_interview_questions", args));
  const questions = Array.from({ length: 4 }, () => ({ question: "问".repeat(2000), answer: "答".repeat(2000), stuck: "卡".repeat(2000), feedback: "评".repeat(2000) }));
  data(await call("save_application_interview_questions", { ...args, expectedRevision: initial.revision, questions }));
  expect(data(await call("get_application_interview_questions", args))).toMatchObject({ truncated: true });
  let offset = 0; let revision: string | undefined; let text = "";
  do {
    const part = data<{ text: string; revision: string; nextOffset: number | null }>(await call("read_record_section", { kind: "application_interview_questions", id: round.id, offset, expectedRevision: revision }));
    text += part.text; revision = part.revision;
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (true);
  expect(JSON.parse(text).questions).toEqual(questions);
  vi.stubEnv("RESUME_LIFE_MCP_ALLOWED_TOOLS", "read_record_section"); await connect();
  expect((await call("read_record_section", { kind: "application_interview_questions", id: round.id })).structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
});

it("returns only receipts when daily write tools are allowed without reads", async () => {
  const task = (await import("@/lib/application-preparation")).createPreparationTask(1, "材料");
  const round = (await import("@/lib/applications")).createApplicationInterview(1, { round_name: "技术面" });
  vi.stubEnv("RESUME_LIFE_MCP_ALLOWED_TOOLS", "update_preparation_task,reschedule_application_interview,generate_preparation_plan,save_application_interview_questions"); await connect(true);
  const apps = await import("@/lib/mcp-read");
  expect(data(await call("update_preparation_task", { applicationId: 1, taskId: task.id, expectedRevision: apps.getMcpApplication(1)!.application.revision, done: true }))).toEqual({ id: task.id });
  expect(data(await call("reschedule_application_interview", { applicationId: 1, interviewId: round.id, expectedRevision: apps.getMcpApplication(1)!.application.revision, interview_time: "2026-12-02T10:00:00+08:00" }))).toEqual({ id: round.id });
  const plan = apps.getMcpPreparationPlan(1);
  expect(data(await call("generate_preparation_plan", { applicationId: 1, expectedRevision: plan.revision, contextKey: plan.contextKey }))).toEqual({ applicationId: 1, generated: true });
  const questions = (await import("@/lib/mcp-interview-questions")).getMcpInterviewQuestions(1, round.id);
  expect(data(await call("save_application_interview_questions", { applicationId: 1, interviewId: round.id, expectedRevision: questions.revision, questions: [] }))).toEqual({ id: round.id });
});

it("finds generated and saved drafts by application without exposing their payload in discovery", async () => {
  await connect(true, true);
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockResolvedValue(JSON.stringify(model));
  const draft = data<Draft>(await generate("recover-this-draft"));
  expect(data(await status(draft.idempotencyKey))).toMatchObject({ status: "succeeded", draftId: draft.draftId, draftAvailable: true, saved: false });
  const saved = data<{ id: number }>(await call("save_ai_draft", { draftId: draft.draftId, expectedRevision: draft.sourceRevision }));
  const page = data<{ items: object[] }>(await call("list_ai_drafts", { applicationId: 1, kind: "jd" }));
  expect(page.items).toEqual([expect.objectContaining({ id: draft.draftId, saved: true, savedRecord: { id: saved.id, kind: "jd" }, idempotencyKey: draft.idempotencyKey })]);
  expect(JSON.stringify(page)).not.toContain("payload"); expect(JSON.stringify(page)).not.toContain("mustSkills");
  expect(data(await call("get_ai_draft", { id: draft.draftId }))).toMatchObject({ saved: true, savedRecord: { id: saved.id, kind: "jd" }, payload: expect.any(String) });
  expect(data(await generate(draft.idempotencyKey))).toMatchObject({ draftId: draft.draftId, saved: true }); expect(chat).toHaveBeenCalledTimes(1);
});

it("persists successful generation replay across reopening the database and server", async () => {
  await connect(false, true);
  vi.spyOn(await import("@/lib/llm"), "chat").mockResolvedValue(JSON.stringify(model));
  const key = "r".repeat(128); const draft = data<Draft>(await generate(key)); expect(draft.idempotencyKey).toBe(key);
  await client.close(); await server.close(); db.close(); vi.resetModules();
  db = (await import("@/lib/db")).getDb();
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockRejectedValue(new Error("must not call model on replay"));
  await connect(false, true);
  expect(data(await generate(key))).toMatchObject({ draftId: draft.draftId, sourceRevision: draft.sourceRevision }); expect(chat).not.toHaveBeenCalled();
  (await import("@/lib/applications")).updateApplication(1, { jd: "网页编辑之后的 JD" });
  expect(data(await generate(key))).toMatchObject({ draftId: draft.draftId, sourceRevision: draft.sourceRevision }); expect(chat).not.toHaveBeenCalled();
});

it.each(["capacity", "429", "408", "504", "upstream-timeout"] as const)("does not advertise a terminal generation %s as retryable", async mode => {
  await connect(false, true);
  const llm = await import("@/lib/llm");
  const failures = {
    capacity: new llm.LlmBusyError("private provider detail"),
    "429": new llm.LlmHttpError(429, null),
    "408": new llm.LlmHttpError(408, null),
    "504": new llm.LlmHttpError(504, null),
    "upstream-timeout": new llm.LlmTimeoutError("private provider detail"),
  };
  const chat = vi.spyOn(llm, "chat").mockRejectedValue(failures[mode]);
  const key = `terminal-generation-${mode}`;
  const code = mode === "capacity" || mode === "429" ? "BUSY" : "TIMEOUT";
  const result = await generate(key);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: false, error: { code, retryable: false, message: expect.stringContaining("get_ai_generation_request") } });
  const text = result.content.find(item => item.type === "text");
  expect(text?.type === "text" ? JSON.parse(text.text) : null).toEqual(result.structuredContent);
  expect(JSON.stringify(result)).not.toContain("private provider detail");
  expect(data(await status(key))).toMatchObject({ status: "failed", errorCode: code, draftAvailable: false });
  expect((await generate(key)).structuredContent).toMatchObject({ error: { code: "CONFLICT", retryable: false } });
  expect(chat).toHaveBeenCalledTimes(1);
});

it("does not advertise a persisted generation timeout as retryable", async () => {
  vi.stubEnv("RESUME_LIFE_MCP_TIMEOUT_MS", "400");
  await connect(false, true);
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockImplementation((_task, _messages, options) => new Promise<string>((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  }));
  const key = "persisted-timeout-generation";
  const result = await generate(key);
  expect(result.structuredContent).toMatchObject({ error: { code: "TIMEOUT", retryable: false, message: expect.stringContaining("get_ai_generation_request") } });
  expect(data(await status(key))).toMatchObject({ status: "failed", errorCode: "TIMEOUT", draftAvailable: false });
  expect((await generate(key)).structuredContent).toMatchObject({ error: { code: "CONFLICT", retryable: false } });
  expect(chat).toHaveBeenCalledTimes(1);
});

it("keeps a pre-claim database busy failure retryable with the original generation key", async () => {
  await connect(false, true);
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockResolvedValue(JSON.stringify(model));
  const { DatabaseSync } = await import("node:sqlite");
  const blocker = new DatabaseSync(path.join(directory, "data", "resume-life.db"));
  const key = "pre-claim-busy-generation";
  db.exec("PRAGMA busy_timeout=25");
  blocker.exec("BEGIN IMMEDIATE");
  try {
    expect((await generate(key)).structuredContent).toMatchObject({ error: { code: "BUSY", retryable: true } });
    expect(db.prepare("SELECT request_key FROM mcp_generation_requests WHERE request_key=?").get(key)).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  } finally {
    blocker.exec("ROLLBACK"); blocker.close(); db.exec("PRAGMA busy_timeout=5000");
  }
  expect(data(await generate(key))).toMatchObject({ idempotencyKey: key, saved: false });
  expect(chat).toHaveBeenCalledTimes(1);
});

it("reserves a pending key once and lets callers query it while the model is running", async () => {
  await connect(false, true);
  let release!: (text: string) => void;
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockImplementation(() => new Promise<string>(resolve => { release = resolve; }));
  const pending = generate("concurrent-generation-key"); await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
  expect(data(await status("concurrent-generation-key"))).toMatchObject({ status: "pending", draftId: null, draftAvailable: false });
  expect((await generate("concurrent-generation-key")).structuredContent).toMatchObject({ error: { code: "BUSY", retryable: true } });
  release(JSON.stringify(model)); const draft = data<Draft>(await pending);
  expect(data(await generate("concurrent-generation-key"))).toMatchObject({ draftId: draft.draftId }); expect(chat).toHaveBeenCalledTimes(1);
});

it("reserves generation keys across two stdio processes and replays them after restarting a process", async () => {
  vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", "mcp-cross-process-settings-key");
  let calls = 0; let release: (() => void) | undefined;
  const provider = createServer(async (request, response) => {
    request.resume(); calls++;
    await new Promise<void>(resolve => { release = resolve; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(model) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing local provider address");
  (await import("@/lib/settings")).writeSettings({ base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-provider-key", model_question: "fixture", api_format: "openai_chat", proxy_enabled: false });
  const children: Client[] = [];
  const child = async () => {
    const instance = new Client({ name: "generation-process-test", version: "1" }); children.push(instance);
    await instance.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("scripts/mcp.mjs")], cwd: directory, stderr: "ignore",
      env: { RESUME_LIFE_DATA_DIR: path.join(directory, "data"), RESUME_LIFE_SETTINGS_KEY: "mcp-cross-process-settings-key", RESUME_LIFE_MCP_WRITE_ENABLED: "false", RESUME_LIFE_MCP_LLM_ENABLED: "true",
        RESUME_LIFE_MCP_ALLOWED_TOOLS: "analyze_application_jd,get_ai_generation_request", RESUME_LIFE_MCP_TIMEOUT_MS: "10000" } }));
    return instance;
  };
  try {
    const first = await child(); const second = await child();
    const args = { name: "analyze_application_jd", arguments: { applicationId: 1, idempotencyKey: "cross-process-generation" } };
    const pending = first.callTool(args); void pending.catch(() => {});
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5000 });
    const reserved = db.prepare("SELECT status,generation FROM mcp_generation_requests WHERE request_key='cross-process-generation'").get();
    expect(reserved).toMatchObject({ status: "pending" });
    const duplicate = await second.callTool(args);
    expect(duplicate.structuredContent).toMatchObject({ error: { code: "BUSY" } });
    release!(); const draft = data<Draft>(await pending);
    await first.close();
    const restarted = await child();
    expect(data(await restarted.callTool(args))).toMatchObject({ draftId: draft.draftId });
    expect(data(await second.callTool({ name: "get_ai_generation_request", arguments: { idempotencyKey: "cross-process-generation" } }))).toMatchObject({ status: "succeeded", draftAvailable: true });
    expect(calls).toBe(1);
  } finally {
    release?.();
    for (const instance of children) await instance.close();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 25_000);

it.each(["cancel", "disconnect"])("keeps a queryable cancelled request after client %s", async mode => {
  await connect(false, true);
  let aborted = false;
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockImplementation((_task, _messages, options) => new Promise<string>((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
  }));
  const controller = new AbortController();
  const pending = client.callTool({ name: "analyze_application_jd", arguments: { applicationId: 1, idempotencyKey: "cancelled-generation-key" } }, { signal: controller.signal }).catch(error => error);
  await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
  if (mode === "cancel") controller.abort(); else await client.close();
  await pending; await vi.waitFor(() => expect(aborted).toBe(true));
  await vi.waitFor(() => expect(db.prepare("SELECT status,error_code FROM mcp_generation_requests WHERE request_key='cancelled-generation-key'").get()).toEqual({ status: "failed", error_code: "CANCELLED" }));
  await connect(false, true);
  expect(data(await status("cancelled-generation-key"))).toMatchObject({ status: "failed", errorCode: "CANCELLED", draftAvailable: false });
  expect((await generate("cancelled-generation-key")).structuredContent).toMatchObject({ error: { code: "CONFLICT" } }); expect(chat).toHaveBeenCalledTimes(1);
});

it("retains failed and interrupted request tombstones and never repeats model calls for their keys", async () => {
  await connect(false, true);
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockResolvedValue("invalid JSON");
  expect((await generate("failed-generation-key")).structuredContent).toMatchObject({ error: { code: "MODEL_OUTPUT" } });
  expect(data(await status("failed-generation-key"))).toMatchObject({ status: "failed", errorCode: "MODEL_OUTPUT" });
  expect((await generate("failed-generation-key")).structuredContent).toMatchObject({ error: { code: "CONFLICT" } }); expect(chat).toHaveBeenCalledTimes(1);
  const { inTransaction } = await import("@/lib/db");
  inTransaction(() => db.prepare(`INSERT INTO mcp_generation_requests (request_key,input_hash,generation,kind,application_id,source_revision,owner_token,status,created_at,updated_at,lease_expires_at)
    SELECT 'interrupted-generation-key',input_hash,generation,kind,application_id,source_revision,'crashed-owner','pending',created_at,updated_at,'2000-01-01T00:00:00.000Z' FROM mcp_generation_requests WHERE request_key='failed-generation-key'`).run());
  expect(data(await status("interrupted-generation-key"))).toMatchObject({ status: "interrupted" });
  expect((await generate("interrupted-generation-key")).structuredContent).toMatchObject({ error: { code: "CONFLICT" } }); expect(chat).toHaveBeenCalledTimes(1);
});

it("keeps saved record discovery after draft expiry and removes cached payloads with discarded drafts", async () => {
  await connect(true, true);
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockResolvedValue(JSON.stringify(model));
  const draft = data<Draft>(await generate("expiring-generation-key"));
  const saved = data<{ id: number }>(await call("save_ai_draft", { draftId: draft.draftId, expectedRevision: draft.sourceRevision }));
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 25 * 60 * 60 * 1000));
  expect(data(await status(draft.idempotencyKey))).toMatchObject({ status: "succeeded", draftAvailable: false, savedRecord: { id: saved.id, kind: "jd" } });
  expect((await generate(draft.idempotencyKey)).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  expect((await call("get_ai_draft", { id: draft.draftId })).structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(data(await call("list_ai_drafts", { applicationId: 1 }))).toMatchObject({ items: [] });
  expect(data(await call("list_ai_drafts", { applicationId: 1, includeExpired: true }))).toMatchObject({ items: [expect.objectContaining({ expired: true, saved: true })] });
  data(await generate("new-generation-after-expiry"));
  expect(db.prepare("SELECT response_json FROM mcp_generation_requests WHERE request_key=?").get(draft.idempotencyKey)).toEqual({ response_json: null });
  expect(data(await status(draft.idempotencyKey))).toMatchObject({ saved: true, draftAvailable: false }); expect(chat).toHaveBeenCalledTimes(2);
});

it("invalidates generation keys on restored data and rejects using one key for another tool or application", async () => {
  await connect(false, true);
  const chat = vi.spyOn(await import("@/lib/llm"), "chat").mockResolvedValue(JSON.stringify(model));
  data(await generate("generation-boundary-key"));
  const second = (await import("@/lib/applications")).createApplication({ company: "其他公司", role: "开发", jd: "TypeScript" });
  expect((await call("analyze_application_jd", { applicationId: second.id, idempotencyKey: "generation-boundary-key" })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  expect((await call("diagnose_application_resume", { applicationId: 1, idempotencyKey: "generation-boundary-key" })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation").run("restored-model-data");
  expect(data(await status("generation-boundary-key"))).toMatchObject({ status: "invalidated", draftAvailable: false, saved: false });
  expect((await generate("generation-boundary-key")).structuredContent).toMatchObject({ error: { code: "CONFLICT" } }); expect(chat).toHaveBeenCalledTimes(1);
});

it("filters operation logs by receipt request ID and composes tool, error and target filters with pagination", async () => {
  const missing = await call("get_application", { id: 999 });
  const requestId = (missing.structuredContent as { meta: { requestId: string } }).meta.requestId;
  data(await call("get_application", { id: 1 }));
  const found = data<{ items: object[] }>(await call("list_mcp_operations", { requestId, tool: "get_application", errorCode: "NOT_FOUND", targetId: 999, status: "error" }));
  expect(found.items).toEqual([expect.objectContaining({ request_id: requestId, target_id: 999, tool: "get_application", error_code: "NOT_FOUND" })]);
  expect(data(await call("list_mcp_operations", { requestId, status: "success" }))).toMatchObject({ items: [] });
  await call("get_application", { id: 998 }); await call("get_application", { id: 997 });
  const page = data<{ items: { target_id: number }[]; nextCursor: string }>(await call("list_mcp_operations", { tool: "get_application", errorCode: "NOT_FOUND", limit: 1 }));
  expect(page.items[0]?.target_id).toBe(997);
  expect(data(await call("list_mcp_operations", { tool: "get_application", errorCode: "NOT_FOUND", limit: 1, cursor: page.nextCursor }))).toMatchObject({ items: [expect.objectContaining({ target_id: 998 })] });
  expect((await call("list_mcp_operations", { tool: "arbitrary-table" })).structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
});
