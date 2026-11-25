import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { examplePortrait, runApplicationWorkflow } from "../../examples/mcp/workflow.mjs";

let directory: string;
let db: import("node:sqlite").DatabaseSync;
let server: import("@modelcontextprotocol/server").McpServer;
let client: Client;
let publishedId: number;
let chat = vi.fn(async () => JSON.stringify(examplePortrait));

async function connect(allowed?: string, write = true, llm = true) {
  await client?.close(); await server?.close();
  vi.stubEnv("RESUME_LIFE_MCP_ALLOWED_TOOLS", allowed);
  vi.stubEnv("RESUME_LIFE_MCP_WRITE_ENABLED", String(write));
  vi.stubEnv("RESUME_LIFE_MCP_LLM_ENABLED", String(llm));
  server = (await import("./server")).createResumeLifeMcpServer();
  client = new Client({ name: "external-agent-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
}

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-agent-workflows-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  vi.stubEnv("RESUME_LIFE_MCP_TIMEOUT_MS", undefined);
  db = (await import("@/lib/db")).getDb();
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'发布简历',?,?)").run(timestamp, timestamp);
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES (1,'summary-1','summary','简介',0,?,?)")
    .run(JSON.stringify({ text: "实现本地 SQLite 工具集成。" }), timestamp);
  publishedId = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "首次发布" }).id;
  (await import("@/lib/applications")).createApplication({ company: "测试公司", role: "工程师", jd: "维护本地 SQLite 数据库。", stage: "applied", resume_id: 1, resume_version_id: publishedId });
  chat = vi.fn(async () => JSON.stringify(examplePortrait));
  vi.spyOn(await import("@/lib/safe-llm"), "safeChat").mockImplementation(chat);
  await connect();
});

afterEach(async () => {
  await client?.close(); await server?.close(); db?.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-agent-workflows-")) throw new Error("Unsafe test cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
function data<T = Record<string, unknown>>(result: CallToolResult): T {
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: true });
  return (result.structuredContent as { data: unknown }).data as T;
}
const app = async () => data<{ application: { revision: string; resume_version_id: number; jd: string; next_interview_at: string } }>(await call("get_application", { id: 1 })).application;
type Context = { sourceRevision: string; fullContent: Record<string, unknown> };
type Draft = { draftId: number; sourceRevision: string; idempotencyKey: string };
const context = async (kind = "jd", extra = {}) => data<Context>(await call("get_ai_workflow_context", { applicationId: 1, kind, ...extra }));
async function externalJd(key = "external-jd-key") {
  const current = await context();
  const args = { kind: "jd", applicationId: 1, expectedSourceRevision: current.sourceRevision, idempotencyKey: key, result: examplePortrait };
  return { args, draft: data<Draft>(await call("submit_ai_draft", args)) };
}
async function readFull(pointer: Record<string, unknown>) {
  const identity = Object.fromEntries(Object.entries(pointer).filter(([name]) => name !== "tool"));
  let offset = 0; let expectedRevision: string | undefined; const fragments: string[] = [];
  for (;;) {
    const part = data<{ text: string; nextOffset: number | null; revision: string }>(await call("read_record_section", { ...identity, offset, ...(expectedRevision ? { expectedRevision } : {}) }));
    fragments.push(part.text);
    if (part.nextOffset === null) return JSON.parse(fragments.join(""));
    offset = part.nextOffset; expectedRevision = part.revision;
  }
}

it("runs the reusable complete preparation and interview workflow without server model calls", async () => {
  const result = await runApplicationWorkflow(async (name: string, args: Record<string, unknown>) => data(await call(name, args)), { prefix: "sdk-full-workflow" });
  expect(db.prepare("SELECT status,location FROM application_interviews WHERE id=?").get(result.interviewId)).toEqual({ status: "completed", location: "线上" });
  expect(db.prepare("SELECT done FROM application_preparation_tasks WHERE id=?").get(result.taskId)).toEqual({ done: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM application_interview_recaps WHERE id=?").get(result.reviewId)).toEqual({ n: 1 });
  expect(chat).not.toHaveBeenCalled();
});

it("publishes explicit contracts for all tools and mutually exclusive success/failure envelopes", async () => {
  const tools = (await client.listTools()).tools;
  expect(tools).toHaveLength(136);
  for (const tool of tools) {
    expect(tool.outputSchema?.type, tool.name).toBe("object");
    expect(tool.outputSchema?.oneOf, tool.name).toHaveLength(2);
    const schema = (await import("./output-schemas")).toolOutputSchema(tool.name, () => true);
    const meta = { requestId: "7e38f573-cbed-4c33-8358-ea14cb9ff1fa", durationMs: 0 };
    expect(schema.safeParse({ ok: true, meta }).success, tool.name).toBe(false);
    expect(schema.safeParse({ ok: false, meta }).success, tool.name).toBe(false);
    expect(schema.safeParse({ ok: false, error: { code: "NOT_FOUND", message: "missing", retryable: false }, meta }).success, tool.name).toBe(true);
  }
});

it("accepts external drafts once, supports reordered JSON fields, and recovers the saved record after reconnect", async () => {
  const { args, draft } = await externalJd();
  expect(data(await call("submit_ai_draft", { ...args, result: Object.fromEntries(Object.entries(examplePortrait).reverse()) }))).toMatchObject({ draftId: draft.draftId });
  expect((await call("submit_ai_draft", { ...args, result: { ...examplePortrait, role: "不同岗位" } })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  expect(data(await call("get_ai_generation_request", { idempotencyKey: args.idempotencyKey }))).toMatchObject({ origin: "external", phase: "ready" });
  const saved = data<{ id: number }>(await call("save_ai_draft", { draftId: draft.draftId, expectedRevision: draft.sourceRevision }));
  await connect();
  expect(data(await call("get_ai_generation_request", { idempotencyKey: args.idempotencyKey }))).toMatchObject({ saved: true, phase: "saved", savedRecord: { id: saved.id, kind: "jd" } });
  expect(data(await call("submit_ai_draft", args))).toMatchObject({ draftId: draft.draftId, saved: true });
  expect(db.prepare("SELECT COUNT(*) AS n FROM jd_portraits").get()).toEqual({ n: 1 });
  expect(chat).not.toHaveBeenCalled();
});

it("rejects malformed external results and stale source tokens before creating drafts or generation receipts", async () => {
  const current = await context();
  const args = { kind: "jd", applicationId: 1, expectedSourceRevision: current.sourceRevision, idempotencyKey: "invalid-external-key", result: { role: "不完整" } };
  expect((await call("submit_ai_draft", args)).structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  (await import("@/lib/applications")).updateApplication(1, { jd: "岗位要求已变化。" });
  expect((await call("submit_ai_draft", { ...args, result: examplePortrait })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_drafts").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_generation_requests").get()).toEqual({ n: 0 });
});

it("refuses to archive an accepted draft after its JD changes", async () => {
  const { draft } = await externalJd();
  (await import("@/lib/applications")).updateApplication(1, { jd: "新的岗位要求。" });
  expect((await call("save_ai_draft", { draftId: draft.draftId, expectedRevision: draft.sourceRevision })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  expect(db.prepare("SELECT COUNT(*) AS n FROM jd_portraits").get()).toEqual({ n: 0 });
});

it("accepts and archives a complete diagnosis against the published resume and exposes paginated history", async () => {
  const current = await context("diagnosis");
  const report = { match: 7, summary: "已有本地数据库经验。", modules: [{ module_key: "summary-1", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [] }] };
  const draft = data<Draft>(await call("submit_ai_draft", { kind: "diagnosis", applicationId: 1, expectedSourceRevision: current.sourceRevision, idempotencyKey: "external-diagnosis-key", result: report }));
  const saved = data<{ id: number }>(await call("save_ai_draft", { draftId: draft.draftId, expectedRevision: draft.sourceRevision }));
  expect(data(await call("list_resume_diagnoses", { resumeId: 1, applicationId: 1, limit: 1 }))).toMatchObject({ items: [{ id: saved.id, resume_version_id: publishedId, match: 7 }] });
  expect(data(await call("get_resume_diagnosis", { id: saved.id }))).toMatchObject({ report: { match: 7 }, resume_snapshot: { title: "发布简历" } });
  expect(chat).not.toHaveBeenCalled();
});

it("updates current JD and published version while retaining the original submission snapshot", async () => {
  const applications = await import("@/lib/applications");
  const submission = applications.getApplicationSubmission(1);
  db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "新增项目经历。" }));
  const next = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "第二版" });
  const revision = (await app()).revision;
  expect(data(await call("update_application", { id: 1, expectedRevision: revision, jd: "新岗位要求。", resume_version_id: next.id }))).toMatchObject({ jd: "新岗位要求。", resume_version_id: next.id });
  expect(applications.getApplicationSubmission(1)).toEqual(submission);
  expect((await call("update_application", { id: 1, expectedRevision: revision, notes: "过期覆盖" })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
});

it("pages candidate and linked materials, guards concurrent association edits and preserves full portrait content", async () => {
  const { draft } = await externalJd();
  const saved = data<{ id: number }>(await call("save_ai_draft", { draftId: draft.draftId, expectedRevision: draft.sourceRevision }));
  const first = data<{ revision: string }>(await call("list_application_preparation_resources", { applicationId: 1, kind: "portrait" }));
  await call("set_preparation_resource", { applicationId: 1, kind: "portrait", resourceId: saved.id, linked: false, expectedRevision: first.revision });
  expect((await call("set_preparation_resource", { applicationId: 1, kind: "portrait", resourceId: saved.id, linked: true, expectedRevision: first.revision })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  const candidates = data<{ revision: string; items: { id: number; fullContent: Record<string, unknown> }[] }>(await call("list_application_preparation_resources", { applicationId: 1, kind: "portrait", candidates: true }));
  expect(candidates.items[0]?.id).toBe(saved.id);
  expect(await readFull(candidates.items[0]!.fullContent)).toMatchObject({ result: { role: examplePortrait.role } });
  await call("set_preparation_resource", { applicationId: 1, kind: "portrait", resourceId: saved.id, linked: true, expectedRevision: candidates.revision });
});

it("preserves both intro versions and legacy long/invalid raw data through complete reads", async () => {
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO intros (id,resume_id,resume_version_id,jd,created_at) VALUES (1,1,?,'岗位',?)").run(publishedId, timestamp);
  const long = "历史原稿😀".repeat(6000);
  db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s',?,?)").run(JSON.stringify([{ text: long, comment: "原始点评" }]), timestamp);
  const broken = JSON.stringify([{ text: "保留原稿", comment: "" }, "异常项"]);
  db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'2min',?,?)").run(broken, timestamp);
  const intro = data<{ versions: { kind: string; read_error?: string }[]; fullContent: Record<string, unknown> }>(await call("get_intro", { id: 1 }));
  expect(intro.versions.map(item => item.kind)).toEqual(["30s", "2min"]);
  const full = await readFull(intro.fullContent);
  expect(full.versions[0].sentences[0].text).toBe(long);
  expect(full.versions[1]).toMatchObject({ read_error: expect.any(String), raw_sentences: broken });
});

it("discovers every candidate material through cursor pages and reads the complete interview series", async () => {
  const portrait = (await import("@/lib/jd-portrait")).validateGeneratedJdPortrait(examplePortrait);
  for (let i = 1; i <= 3; i++) db.prepare("INSERT INTO jd_portraits (id,jd,result,created_at) VALUES (?,?,?,'')").run(i, "维护本地 SQLite 数据库。", JSON.stringify(portrait));
  const seen: number[] = [];
  let cursor: string | undefined;
  do {
    const page = data<{ items: { id: number }[]; nextCursor: string | null }>(await call("list_application_preparation_resources", { applicationId: 1, kind: "portrait", candidates: true, limit: 1, ...(cursor ? { cursor } : {}) }));
    seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual([3, 2, 1]);
  const report = "历史系列报告😀".repeat(6000);
  db.prepare("INSERT INTO interview_series (id,resume_id,resume_version_id,jd,rounds,status,final_report,created_at) VALUES (1,1,?,'系列岗位',2,'finished',?,'')").run(publishedId, report);
  for (const round of [2, 1]) db.prepare("INSERT INTO interviews (resume_id,resume_version_id,jd,series_id,round_no,status,created_at) VALUES (1,?,'系列岗位',1,?,'finished','')").run(publishedId, round);
  const series = data<{ interviews: { id: number; round_no: number }[]; fullContent: Record<string, unknown>; truncated: boolean }>(await call("get_interview_series", { id: 1 }));
  expect(series.interviews.map(item => item.round_no)).toEqual([1, 2]);
  expect(series.truncated).toBe(true);
  expect((await readFull(series.fullContent)).final_report).toBe(report);
});

it("retains corrupt historical portrait and diagnosis payloads through full-content reads", async () => {
  const raw = "历史损坏原稿😀".repeat(6000);
  db.prepare("INSERT INTO jd_portraits (id,jd,result,created_at) VALUES (1,'原岗位',?,'')").run(raw);
  const portrait = data<{ fullContent: Record<string, unknown> }>(await call("get_jd_portrait", { id: 1 }));
  expect(await readFull(portrait.fullContent)).toMatchObject({ result: null, read_error: expect.any(String), raw_result: raw });
  db.prepare("INSERT INTO resume_diagnoses (id,resume_id,resume_version_id,job_id,job_title,jd,report,resume_snapshot,adoptions,created_at) VALUES (1,1,?,'original-job','原岗位','原 JD',?,'{}','[]','')").run(publishedId, raw);
  const diagnosis = data<{ fullContent: Record<string, unknown> }>(await call("get_resume_diagnosis", { id: 1 }));
  expect(await readFull(diagnosis.fullContent)).toMatchObject({ report: null, corruptedFields: ["report", "resume_snapshot"], raw_fields: { report: raw, resume_snapshot: "{}" } });
  expect(db.prepare("SELECT result FROM jd_portraits WHERE id=1").get()).toEqual({ result: raw });
});

it("rejects cross-application round edits and synchronizes the next interview after cancellation and completion", async () => {
  const other = data<{ id: number }>(await call("create_application", { company: "另一公司", role: "另一岗位", idempotencyKey: "other-application-key" }));
  const first = data<{ id: number }>(await call("schedule_application_interview", { applicationId: 1, expectedRevision: (await app()).revision,
    round_name: "初面", interview_time: "2026-12-01T10:00:00+08:00", idempotencyKey: "round-one-boundary-key" }));
  const second = data<{ id: number }>(await call("schedule_application_interview", { applicationId: 1, expectedRevision: (await app()).revision,
    round_name: "复面", interview_time: "2026-12-02T10:00:00+08:00", idempotencyKey: "round-two-boundary-key" }));
  const otherRevision = data<{ application: { revision: string } }>(await call("get_application", { id: other.id })).application.revision;
  expect((await call("update_application_interview", { applicationId: other.id, interviewId: first.id, expectedRevision: otherRevision, notes: "跨投递覆盖" })).structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
  data(await call("update_application_interview", { applicationId: 1, interviewId: first.id, expectedRevision: (await app()).revision, status: "cancelled", round_name: "已取消初面", location: "线上" }));
  expect((await app()).next_interview_at).toBe("2026-12-02T02:00:00.000Z");
  data(await call("update_application_interview", { applicationId: 1, interviewId: second.id, expectedRevision: (await app()).revision, status: "completed" }));
  expect((await app()).next_interview_at).toBe("");
});

it.each(["jd", "diagnosis", "review"])("blocks %s AI context and full-content permission bypasses", async kind => {
  await connect("get_ai_workflow_context,read_record_section", false, false);
  const extra = kind === "review" ? { interviewId: 1 } : {};
  expect((await call("get_ai_workflow_context", { kind, applicationId: 1, ...extra })).structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect((await call("read_record_section", { kind: "ai_workflow_context", workflowKind: kind, id: 1, ...extra })).structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
});

it.each(["jd", "diagnosis", "review"])("requires source read permissions when submitting an external %s draft", async kind => {
  const current = await context();
  await connect("submit_ai_draft", true, false);
  expect((await call("submit_ai_draft", { kind, applicationId: 1, ...(kind === "review" ? { interviewId: 1 } : {}),
    expectedSourceRevision: current.sourceRevision, idempotencyKey: "unauthorized-draft-key", result: examplePortrait })).structuredContent)
    .toMatchObject({ error: { code: "FORBIDDEN" } });
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_drafts").get()).toEqual({ n: 0 });
});

it("keeps the read-only configuration from invoking any of the new writes", async () => {
  await connect(undefined, false, false);
  expect((await client.listTools()).tools).toHaveLength(83);
  for (const name of ["submit_ai_draft", "set_preparation_resource", "update_application_interview", "bookmark_practice_question", "save_notebook_note", "submit_review", "maintain_mcp_state"]) {
    expect((await call(name)).structuredContent, name).toMatchObject({ error: { code: "FORBIDDEN" } });
  }
});

it("provides machine-readable result formats and reconstructs a long legacy external context without splitting Unicode", async () => {
  const long = "完整上下文😀".repeat(10_000);
  db.prepare("UPDATE applications SET jd=? WHERE id=1").run(long);
  const summary = data<{ resultSchema: { required: string[] }; fullContent: Record<string, unknown>; truncated: boolean }>(await call("get_ai_workflow_context", { kind: "jd", applicationId: 1 }));
  expect(summary.truncated).toBe(true);
  expect(summary.resultSchema.required).toEqual(["role", "must_skills", "followups", "company_style"]);
  expect((await readFull(summary.fullContent)).context.application.jd).toBe(long);
  db.prepare("UPDATE applications SET jd='维护本地数据库。' WHERE id=1").run();
  const diagnosis = data<{ resultSchema: { properties: { modules: { items: { properties: { module_key: { enum?: string[]; const?: string } } } } } } }>(await call("get_ai_workflow_context", { kind: "diagnosis", applicationId: 1 }));
  expect(diagnosis.resultSchema.properties.modules.items.properties.module_key).toMatchObject({ type: "string" });
});

async function bookmark() {
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO drills (id,source,created_at) VALUES (1,'bank',?)").run(timestamp);
  db.prepare("INSERT INTO drill_questions (id,drill_id,idx,kind,question,answer,comment,reference) VALUES (1,1,0,'knowledge','解释事务边界','原答快照','原始反馈','原始参考')").run();
  const args = { source: "drill", sourceId: 1, idempotencyKey: "bookmark-question-key" };
  const saved = data<{ id: number }>(await call("bookmark_practice_question", args));
  expect(data(await call("bookmark_practice_question", args))).toEqual(saved);
  return saved.id;
}

it("writes independent notes visible through the Web domain without modifying bookmarked snapshots", async () => {
  const notebookId = await bookmark();
  const snapshot = db.prepare("SELECT question,answer,comment,reference FROM notebook_entries WHERE id=?").get(notebookId);
  const before = data<{ noteRevision: string }>(await call("get_notebook_entry", { id: notebookId }));
  const args = { notebookId, expectedRevision: before.noteRevision, content: "补充笔记：在同一事务中复核来源版本。", idempotencyKey: "notebook-note-key" };
  const saved = data(await call("save_notebook_note", args));
  expect(data(await call("save_notebook_note", args))).toEqual(saved);
  const route = await import("@/app/api/notebook/[id]/note/route");
  const response = await route.GET(new Request("http://localhost/api/notebook/1/note"), { params: Promise.resolve({ id: String(notebookId) }) });
  expect(await response.json()).toMatchObject({ note: { content: args.content } });
  const conflict = await route.PUT(new Request("http://localhost/api/notebook/1/note", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "覆盖", expectedRevision: before.noteRevision }) }), { params: Promise.resolve({ id: String(notebookId) }) });
  expect(conflict.status).toBe(409);
  const latest = data<{ noteRevision: string }>(await call("get_notebook_entry", { id: notebookId }));
  const webWrite = await route.PUT(new Request("http://localhost/api/notebook/1/note", { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "网页补充笔记", expectedRevision: latest.noteRevision }) }), { params: Promise.resolve({ id: String(notebookId) }) });
  expect(webWrite.status).toBe(200);
  expect(data(await call("get_notebook_entry", { id: notebookId }))).toMatchObject({ note: { content: "网页补充笔记" } });
  expect((await call("save_notebook_note", { ...args, idempotencyKey: "stale-notebook-note-key", expectedRevision: latest.noteRevision })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  expect(db.prepare("SELECT question,answer,comment,reference FROM notebook_entries WHERE id=?").get(notebookId)).toEqual(snapshot);
});

it("uses the same review schedule as Web and does not count idempotent or stale submissions twice", async () => {
  await bookmark();
  const page = data<{ items: { id: number; review_count: number }[] }>(await call("list_review_cards", { timeZone: "Asia/Hong_Kong" }));
  const card = page.items[0]!;
  const args = { cardId: card.id, answer: "复核与写入应在同一事务中进行。", grade: "good", expectedReviewCount: card.review_count, requestId: "764ff9b2-643e-4f12-937c-2cf16b682940", timeZone: "Asia/Hong_Kong" };
  const saved = data(await call("submit_review", args));
  expect(data(await call("submit_review", args))).toEqual(saved);
  expect(data(await call("get_review_submission", { cardId: card.id, requestId: args.requestId }))).toMatchObject({ card: { review_count: 1 }, attempt: { id: saved.id, grade: "good" } });
  expect((await call("submit_review", { ...args, requestId: "a9e343a4-0388-4282-b20f-02ae9833ab51" })).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  const detail = data<{ review_count: number; attempts: unknown[] }>(await call("get_review_card", { id: card.id }));
  expect(detail.review_count).toBe(1); expect(detail.attempts).toHaveLength(1);
  const web = await import("@/app/api/reviews/[id]/route");
  const response = await web.POST(new Request("http://localhost/api/reviews/1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "网页端再次复习。", grade: "easy", expected_review_count: 1, request_id: "58c823c4-fb31-4b1e-a42a-fcc734afae4d" }) }), { params: Promise.resolve({ id: String(card.id) }) });
  expect(response.status).toBe(200);
  expect(data(await call("get_review_card", { id: card.id }))).toMatchObject({ review_count: 2 });
});

it("reports server generation phases while a model request is running", async () => {
  let release!: (value: string) => void;
  chat.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
  const pending = call("analyze_application_jd", { applicationId: 1, idempotencyKey: "phase-generation-key" });
  await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
  expect(data(await call("get_ai_generation_request", { idempotencyKey: "phase-generation-key" }))).toMatchObject({ origin: "server", phase: "generating", status: "pending" });
  release(JSON.stringify(examplePortrait));
  data(await pending);
  expect(data(await call("get_ai_generation_request", { idempotencyKey: "phase-generation-key" }))).toMatchObject({ phase: "ready", status: "succeeded" });
});

it("cleans expired draft payloads while retaining generation tombstones and saved-record discovery", async () => {
  const { args, draft } = await externalJd();
  const saved = data<{ id: number }>(await call("save_ai_draft", { draftId: draft.draftId, expectedRevision: draft.sourceRevision }));
  db.prepare("UPDATE mcp_drafts SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(draft.draftId);
  expect(data(await call("maintain_mcp_state", { limit: 1 }))).toMatchObject({ removedDrafts: 1, clearedResponses: 1 });
  expect(data(await call("get_ai_generation_request", { idempotencyKey: args.idempotencyKey }))).toMatchObject({ draftAvailable: false, saved: true, savedRecord: { id: saved.id } });
  expect((await call("submit_ai_draft", args)).structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
  expect(db.prepare("SELECT response_json FROM mcp_generation_requests WHERE request_key=?").get(args.idempotencyKey)).toEqual({ response_json: null });
  expect(chat).not.toHaveBeenCalled();
});

it("automatically clears expired payloads during idle time and stops maintenance after close", async () => {
  vi.useFakeTimers();
  const { args, draft } = await externalJd();
  db.prepare("UPDATE mcp_drafts SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(draft.draftId);
  db.prepare("UPDATE mcp_generation_requests SET draft_expires_at='2000-01-01T00:00:00.000Z' WHERE request_key=?").run(args.idempotencyKey);
  await vi.advanceTimersByTimeAsync(1000);
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_drafts").get()).toEqual({ n: 0 });
  expect(data(await call("get_ai_generation_request", { idempotencyKey: args.idempotencyKey }))).toMatchObject({ phase: "expired", draftAvailable: false });
  await client.close(); await server.close();
  db.prepare("INSERT INTO mcp_drafts (kind,application_id,source_revision,payload,created_at,expires_at) VALUES ('jd',1,?,'{}','','2000-01-01T00:00:00.000Z')").run(draft.sourceRevision);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(db.prepare("SELECT COUNT(*) AS n FROM mcp_drafts").get()).toEqual({ n: 1 });
});

it("distinguishes interrupted requests from active generation in diagnostics", async () => {
  const current = await context();
  (await import("@/lib/mcp-generation")).beginMcpGeneration("interrupted-phase-key", { kind: "jd", applicationId: 1 }, current.sourceRevision);
  db.prepare("UPDATE mcp_generation_requests SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();
  expect(data(await call("get_ai_generation_request", { idempotencyKey: "interrupted-phase-key" }))).toMatchObject({ phase: "interrupted" });
  expect(data(await call("get_mcp_status"))).toMatchObject({ generationRequests: { pending: 0, interrupted: 1 } });
});

it.each(["resume_snapshot", "adoptions"] as const)("preserves a valid report when only %s is corrupt", async field => {
  const report = JSON.stringify({ match: 7, summary: "有效的历史诊断报告😀", modules: [{ moduleKey: "summary-1", label: "简介",
    scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [] }] });
  const snapshot = JSON.stringify({ title: "发布简历", modules: [{ key: "summary-1", type: "summary", label: "简介", sort: 0,
    content: { text: "原简历内容", descriptionItems: [], descriptionStyle: "unordered" } }] });
  db.prepare("INSERT INTO resume_diagnoses (id,resume_id,resume_version_id,job_id,job_title,jd,report,resume_snapshot,adoptions,created_at) VALUES (1,1,?,'historical-job','原岗位','原 JD',?,?,?,'')")
    .run(publishedId, report, field === "resume_snapshot" ? "{}" : snapshot, field === "adoptions" ? "损坏的 JSON" : "[]");
  const diagnosis = data<{ report: null; corruptedFields: string[]; fullContent: Record<string, unknown> }>(await call("get_resume_diagnosis", { id: 1 }));
  expect(diagnosis).toMatchObject({ report: null, corruptedFields: [field] });
  const full = await readFull(diagnosis.fullContent);
  expect(full.raw_fields.report).toBe(report);
  expect(full.raw_fields[field]).toBe(field === "resume_snapshot" ? "{}" : "损坏的 JSON");
  expect((await import("@/lib/diagnosis-history")).loadDiagnosis(1, 1)).toMatchObject({ report: null, corruptedFields: [field] });
  expect((await import("@/lib/diagnosis-history")).loadDiagnosis(1, 1)).not.toHaveProperty("raw_fields");
  expect(db.prepare("SELECT report FROM resume_diagnoses WHERE id=1").get()).toEqual({ report });
});

it("reads every long review answer through bounded history pages and exact submission pointers", async () => {
  await bookmark();
  const cardId = data<{ items: { id: number }[] }>(await call("list_review_cards")).items[0]!.id;
  db.prepare("UPDATE notebook_entries SET question=?,answer=?,comment=?,reference=? WHERE id=1")
    .run("问题".repeat(1000), "原答".repeat(9000), "点评".repeat(2000), "参考".repeat(2000));
  const answers = [0, 1, 2].map(index => `${index}：${"回答😀".repeat(4500)}\n最后一段必须完整保留。`);
  const submissions: { id: number; requestId: string; answer: string }[] = [];
  for (const [index, answer] of answers.entries()) {
    const requestId = randomUUID();
    const saved = data<{ id: number }>(await call("submit_review", { cardId, answer, grade: "good", expectedReviewCount: index, requestId }));
    submissions.push({ id: saved.id, requestId, answer });
  }
  let cursor: string | undefined;
  const seen: number[] = [];
  do {
    const result = await call("get_review_card", { id: cardId, limit: 1, ...(cursor ? { cursor } : {}) });
    const page = data<{ attempts: { id: number; answer: string; fullContent: Record<string, unknown> }[]; nextCursor: string | null }>(result);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(33_000);
    for (const attempt of page.attempts) {
      const original = submissions.find(item => item.id === attempt.id)!;
      expect(attempt.answer.length).toBeLessThan(original.answer.length);
      expect(attempt.fullContent).toEqual({ tool: "read_record_section", kind: "review_attempt", id: attempt.id });
      const full = await readFull(attempt.fullContent);
      expect(full).toMatchObject({ id: attempt.id, card_id: cardId, request_id: original.requestId, answer: original.answer });
      seen.push(attempt.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(submissions.map(item => item.id).reverse());
  const submission = data<{ fullContent: Record<string, unknown> }>(await call("get_review_submission", { cardId, requestId: submissions[0]!.requestId }));
  expect(await readFull(submission.fullContent)).toMatchObject({ request_id: submissions[0]!.requestId, attempt: { answer: answers[0] } });
});

it("keeps history and exact-submission full reads inside their respective capability boundaries", async () => {
  await bookmark();
  const cardId = data<{ items: { id: number }[] }>(await call("list_review_cards")).items[0]!.id;
  const requestId = randomUUID();
  const attempt = data<{ id: number }>(await call("submit_review", { cardId, answer: "完整复习回答", grade: "good", expectedReviewCount: 0, requestId }));
  await connect("get_review_card,read_record_section", false, false);
  expect(await readFull({ tool: "read_record_section", kind: "review_attempt", id: attempt.id })).toMatchObject({ answer: "完整复习回答" });
  expect((await call("read_record_section", { kind: "review_submission", id: cardId, requestId })).structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
  await connect("get_review_submission,read_record_section", false, false);
  const submission = data<{ fullContent: Record<string, unknown> }>(await call("get_review_submission", { cardId, requestId }));
  expect(await readFull(submission.fullContent)).toMatchObject({ request_id: requestId });
  expect((await call("read_record_section", { kind: "review_attempt", id: attempt.id })).structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
  expect((await call("read_record_section", { kind: "review_submission", id: cardId })).structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  expect((await call("read_record_section", { kind: "review_submission", id: cardId, requestId: randomUUID() })).structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect((await call("read_record_section", { kind: "review_submission", id: cardId + 1, requestId })).structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
});

it.each([
  ["Pacific/Kiritimati", "2026-11-25"],
  ["Pacific/Honolulu", "2026-11-24"],
])("keeps %s dates when reading a complete new review card", async (timeZone, date) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T00:30:00.000Z"));
  await bookmark();
  const cardId = data<{ items: { id: number }[] }>(await call("list_review_cards", { timeZone })).items[0]!.id;
  const card = data<{ next_review_date: string; fullContent: Record<string, unknown> }>(await call("get_review_card", { id: cardId, timeZone }));
  expect(card.next_review_date).toBe(date);
  expect(await readFull(card.fullContent)).toMatchObject({ next_review_date: date });
  expect(card.fullContent).toMatchObject({ timeZone });
  expect((await call("read_record_section", { kind: "review_card", id: cardId, timeZone: "invalid/timezone" })).structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  expect((await call("read_record_section", { kind: "notebook", id: 1, timeZone })).structuredContent).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
});
