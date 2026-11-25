import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resumeTrainingWorkflow, runTrainingWorkflow } from "../../examples/mcp/training-workflow.mjs";

let directory: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer, versionId: number;
const direction = "后端", scores = { depth: 8, structure: 7, authenticity: 9, completeness: 7 };
const evaluation = { ...scores, comment: "正确解释了提交时机。", reference: "应校验当前版本。" };
type Bag = Record<string, unknown>;
const call = (name: string, args: Bag = {}) => client.callTool({ name, arguments: args });
async function ok<T = Bag>(name: string, args: Bag = {}): Promise<T> {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return (result.structuredContent as { data: T }).data;
}
async function fails(name: string, args: Bag, code: string) {
  expect((await call(name, args)).structuredContent).toMatchObject({ ok: false, error: { code } });
}
const req = (method = "GET", body?: unknown) => new Request("http://localhost/api/fixture", { method,
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
const params = <T extends Record<string, string>>(values: T) => ({ params: Promise.resolve(values) });
async function connect(allowlist: Set<string> | null = null, writeEnabled = true) {
  await client?.close(); await server?.close();
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist, writeEnabled, llmEnabled: false, timeoutMs: 60_000 });
  client = new Client({ name: "training", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-training-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  db.exec(`INSERT INTO resumes(id,title,created_at,updated_at) VALUES(1,'履历','','');
    INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'skills','skills','技能',0,'{"items":["SQLite"]}','');
    INSERT INTO bank_entries(id,direction,kind,question,created_at) VALUES(1,'后端','tech','事务是什么？',''),(2,'后端','tech','如何处理写冲突？',''),(3,'产品','behavior','如何安排任务？','');
    INSERT INTO notebook_categories(id,name,created_at) VALUES(1,'技术',''),(2,'表达','');
    INSERT INTO intros(id,resume_id,created_at) VALUES(1,1,'');
    INSERT INTO intro_versions(intro_id,kind,sentences,updated_at) VALUES(1,'30s','[{"text":"原稿","comment":"旧点评"}]',''),(1,'2min','[{"text":"长版","comment":"保留"}]','')`);
  versionId = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "固定版" }).id;
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-training-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
type Token = { revision: string };
const basis = (questionId: number) => ok<Token>("get_practice_answer_context", { questionId });
const grade = async (questionId: number) => ({ questionId, answer: "实际回答", evaluation, expectedRevision: (await basis(questionId)).revision, idempotencyKey: "training-answer:" + questionId });
const seedDrill = (source: string) => {
  const id = Number(db.prepare("INSERT INTO drills(source,direction,created_at) VALUES(?,'方向','')").run(source).lastInsertRowid);
  return Number(db.prepare("INSERT INTO drill_questions(drill_id,idx,question) VALUES(?,1,'请说明实现')").run(id).lastInsertRowid);
};

it("runs all five workflows without server models, replays after reconnect, and exposes saved answers and reports on the Web", async () => {
  const llm = await import("@/lib/safe-llm");
  const chat = vi.spyOn(llm, "safeChat"), stream = vi.spyOn(llm, "safeChatStream");
  const training = await runTrainingWorkflow(ok, { direction, resumeId: 1, versionId, introId: 1 });
  await connect(); await resumeTrainingWorkflow(ok, training);
  const web = await import("@/app/api/drills/[id]/route");
  const drill = await web.GET(req(), { params: Promise.resolve({ id: String(training.session.id) }) });
  expect(await drill.json()).toMatchObject({ questions: [{ answer: training.answer.answer, comment: training.answer.evaluation.comment, review_count: 1 }] });
  const view = await import("@/app/api/interviews/[id]/route");
  const interview = await view.GET(req(), { params: Promise.resolve({ id: String(training.mock.id) }) });
  expect(await interview.json()).toMatchObject({ status: "finished", report: { depth: 8.5 } });
  expect(chat).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
});

it("filters and pages bank and category rows; rejects stale and duplicate selections with no partial session", async () => {
  const list = (cursor?: string) => ok<{ items: {id: number; revision: string}[]; nextCursor: string | null }>("list_bank_entries", { direction, limit: 1, cursor });
  const a = await list(), b = await list(a.nextCursor!);
  expect([a.items[0]!.id,b.items[0]!.id,b.nextCursor]).toEqual([2,1,null]);
  expect(await ok("list_notebook_categories", { limit: 1, cursor: "2" })).toMatchObject({ items: [{ id: 1 }], nextCursor: null });
  const entries = [...a.items, ...b.items].map(({id,revision}) => ({id,revision}));
  await fails("create_practice_session", { entries: [entries[0], entries[0]], idempotencyKey: "duplicate-key" }, "INVALID_ARGUMENT");
  db.exec("UPDATE bank_entries SET question='已编辑' WHERE id=1");
  await fails("create_practice_session", { entries, idempotencyKey: "stale-selection" }, "CONFLICT");
  expect(db.prepare("SELECT count(*) n FROM drills").get()).toEqual({ n: 0 });
  const refreshed = (await list(a.nextCursor!)).items[0]!;
  const selected = { entries: [entries[0], { id: refreshed.id, revision: refreshed.revision }], idempotencyKey: "ordered-session" };
  await ok("create_practice_session", selected);
  db.exec("DELETE FROM bank_entries");
  await ok("create_practice_session", selected);
  expect(db.prepare("SELECT question FROM drill_questions ORDER BY idx").all()).toEqual([{ question: "如何处理写冲突？" }, { question: "已编辑" }]);
});

it("copies the complete literal bank question without changing its saved source", async () => {
  const question = "\ufeff  C++ / C# <T> &amp;\r\n条件：只参与验证。\n  ";
  db.prepare("UPDATE bank_entries SET question=? WHERE id=1").run(question);
  const original = db.prepare("SELECT * FROM bank_entries ORDER BY id").all();
  const entry = (await ok<{ items: { id: number; revision: string }[] }>("list_bank_entries", { direction })).items.find(row => row.id === 1)!;
  const { id } = await ok<{ id: number }>("create_practice_session", { entries: [{ id: entry.id, revision: entry.revision }], idempotencyKey: "literal-bank-copy" });
  const web = await import("@/app/api/drills/[id]/route");
  expect(await (await web.GET(req(), params({ id: String(id) }))).json()).toMatchObject({ questions: [{ question }] });
  expect(db.prepare("SELECT * FROM bank_entries ORDER BY id").all()).toEqual(original);
});

it.each(["\u200b\u2060", "！？ …"])("refuses an imported bank selection without question content: %j", async text => {
  const web = await import("@/app/api/bank/route");
  expect((await web.POST(req("POST", { direction, kind: "tech", text }))).status).toBe(201);
  const original = db.prepare("SELECT * FROM bank_entries ORDER BY id").all();
  const items = (await ok<{ items: { id: number; question: string; revision: string }[] }>("list_bank_entries", { direction })).items;
  const invalid = items.find(row => row.question === text)!, valid = items.find(row => row.id === 1)!;
  await fails("create_practice_session", { entries: [valid, invalid].map(({ id, revision }) => ({ id, revision })), idempotencyKey: "invalid-bank-selection" }, "INVALID_ARGUMENT");
  expect(db.prepare("SELECT count(*) n FROM drills").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT * FROM bank_entries ORDER BY id").all()).toEqual(original);
});

it.each(["unlabelled", "mixed"])("restarts a %s MCP bank selection on the Web after its original bank rows are deleted", async scope => {
  if (scope === "unlabelled") db.exec("UPDATE bank_entries SET direction='' WHERE id=1");
  const items = (await ok<{ items: { id: number; revision: string }[] }>("list_bank_entries")).items;
  const entries = (scope === "unlabelled" ? [1] : [1, 3]).map(id => ({ id, revision: items.find(row => row.id === id)!.revision }));
  const { id } = await ok<{ id: number }>("create_practice_session", { entries, idempotencyKey: "restart-saved-selection" });
  const original = db.prepare("SELECT id,question,kind FROM drill_questions WHERE drill_id=? ORDER BY idx").all(id) as { id: number; question: string; kind: string }[];
  db.exec("DELETE FROM bank_entries");
  const model = vi.spyOn(await import("@/lib/llm"), "chat").mockResolvedValue(JSON.stringify({ questions: [{ question: "假设出现新需求，你会如何验证？", kind: "tech" }] }));
  const web = await import("@/app/api/drills/route");
  const response = await web.POST(req("POST", { source: "bank", previous_drill_id: id, count: 1 }));
  expect(response.status).toBe(201);
  const created = await response.json() as { id: number };
  expect(db.prepare("SELECT source,direction,jd FROM drills WHERE id=?").get(created.id)).toEqual({ source: "bank", direction: scope === "unlabelled" ? "" : "后端、产品", jd: "" });
  const { wrapUntrustedData } = await import("@/lib/prompt-safety");
  const reference = original.map(row => JSON.stringify({ id: row.id, kind: row.kind === "behavior" ? "行为" : "八股", question: row.question })).join("\n");
  expect(model.mock.calls[0]![1][1]!.content).toContain(wrapUntrustedData("question_bank", reference));
  expect(model).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT id,question,kind FROM drill_questions WHERE drill_id=? ORDER BY idx").all(id)).toEqual(original);
});

it.each(["bank", "interview"])("%s grade enrolls only according to Web rules and preserves earlier notebook answers", async source => {
  const id = seedDrill(source), input = await grade(id);
  await ok("submit_practice_answer", input); await ok("submit_practice_answer", input);
  expect(db.prepare("SELECT count(*) n FROM review_cards").get()).toEqual({ n: source === "interview" ? 1 : 0 });
  await ok("bookmark_practice_question", { source: "drill", sourceId: id, idempotencyKey: "bookmark-question" });
  await ok("submit_practice_answer", { ...await grade(id), answer: "新回答", idempotencyKey: "subsequent-answer" });
  expect(db.prepare("SELECT count(*) n FROM review_cards").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT answer FROM notebook_entries").get()).toEqual({ answer: input.answer });
});

it("honors a Web grade that wins the race and does not overwrite it from stale MCP context", async () => {
  const id = seedDrill("bank"), input = await grade(id);
  vi.spyOn(await import("@/lib/safe-llm"), "safeChat").mockResolvedValue(JSON.stringify(evaluation));
  const { POST } = await import("@/app/api/drills/[id]/questions/[qid]/route");
  expect((await POST(req("POST", { answer: "网页抢先保存" }), { params: Promise.resolve({ id: "1", qid: String(id) }) })).status).toBe(200);
  await fails("submit_practice_answer", input, "CONFLICT");
  expect(await ok("get_practice_question", { id })).toMatchObject({ answer: "网页抢先保存" });
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
});

it("rejects a grade read before scoring rules change, even when the question and stored materials stay identical", async () => {
  const questionId = seedDrill("bank"), input = await grade(questionId);
  const rules = await import("@/lib/drill-answer-llm");
  const original = rules.drillEvaluationRules;
  vi.spyOn(rules, "drillEvaluationRules").mockImplementation(params => {
    const current = original(params);
    return { ...current, systemPrompt: "新增评分边界：先核对题目必要要求。\n" + current.systemPrompt };
  });
  const current = await basis(questionId);
  expect(current.revision).not.toBe(input.expectedRevision);
  await fails("submit_practice_answer", input, "CONFLICT");
  expect(db.prepare("SELECT answer,answered_at FROM drill_questions WHERE id=?").get(questionId)).toEqual({ answer: "", answered_at: "" });
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
  await ok("submit_practice_answer", { ...input, expectedRevision: current.revision });
});

it("independent stdio processes replay the same grade and cannot both advance a mock interview turn", async () => {
  const questionId = seedDrill("interview"), input = await grade(questionId);
  const { resume } = await ok<{ resume: Token }>("get_resume", { id: 1, versionId });
  const { id: interviewId } = await ok<{ id: number }>("start_mock_interview", { resumeId: 1, versionId, expectedRevision: resume.revision,
    jd: "数据库", rounds: 2, firstQuestion: "怎样复核材料？", idempotencyKey: "cross-process-mock" });
  const state = await ok<Token & { currentTurnId: number }>("get_mock_interview_state", { interviewId });
  const writers = [0,1].map(i => new Client({ name: `training-writer-${i}`, version: "1" }));
  try {
    await Promise.all(writers.map(writer => writer.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("scripts/mcp.mjs")], cwd: directory,
      env: { RESUME_LIFE_DATA_DIR: directory, RESUME_LIFE_MCP_WRITE_ENABLED: "true", RESUME_LIFE_MCP_LLM_ENABLED: "false",
        RESUME_LIFE_MCP_ALLOWED_TOOLS: "submit_practice_answer,get_practice_answer_context,get_practice_question,list_practice_sessions,get_interview,get_resume,get_mock_interview_state,answer_mock_interview" }, stderr: "ignore" }))));
    const same = await Promise.all(writers.map(writer => writer.callTool({ name: "submit_practice_answer", arguments: input })));
    for (const result of same) expect(result.structuredContent).toMatchObject({ ok: true, data: { id: questionId } });
    expect(db.prepare("SELECT count(*) n FROM review_cards").get()).toEqual({ n: 1 });
    const race = await Promise.all(writers.map((writer, i) => writer.callTool({ name: "answer_mock_interview", arguments: { interviewId, turnId: state.currentTurnId,
      expectedRevision: state.revision, answer: `来自连接 ${i} 的原答`, evaluation: { ...scores, comment: "注明了材料来源。", next_kind: "followup", next_question: "材料发生变化怎么办？" }, idempotencyKey: `mock-racing-${i}` } })));
    expect(race.filter(result => !result.isError)).toHaveLength(1);
    expect(race.find(result => result.isError)?.structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await ok("get_mock_interview_state", { interviewId })).toMatchObject({ answered: 1, currentIndex: 2 });
    expect(db.prepare("SELECT count(*) n FROM interview_turns WHERE interview_id=?").get(interviewId)).toEqual({ n: 2 });
  } finally { await Promise.all(writers.map(writer => writer.close())); }
}, 30_000);

it("rolls back grading, scheduling and the idempotency receipt together if enrollment fails", async () => {
  const id = seedDrill("interview"), input = await grade(id);
  db.exec("CREATE TEMP TRIGGER fail_training_card BEFORE INSERT ON review_cards BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await fails("submit_practice_answer", input, "INTERNAL");
  expect(db.prepare("SELECT answer,answered_at FROM drill_questions").get()).toEqual({ answer: "", answered_at: "" });
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_training_card"); await ok("submit_practice_answer", input);
});

it("gates every new write in readonly mode and authorizes both summary and segmented grading sources", async () => {
  const id = seedDrill("project");
  db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'私有项目','',''); UPDATE drills SET project_id=1");
  const context = await ok<{fullContent: Bag}>("get_practice_answer_context", { questionId: id });
  await connect(null, false);
  for (const tool of ["create_practice_session","submit_practice_answer","save_intro_edit","create_project","add_project_material","start_mock_interview","answer_mock_interview","finish_mock_interview"]) {
    await fails(tool, {}, "FORBIDDEN");
  }
  await connect(new Set(["get_practice_answer_context","read_record_section","get_practice_question","list_practice_sessions"]));
  await fails("get_practice_answer_context", { questionId: id }, "FORBIDDEN");
  await fails("read_record_section", { kind: context.fullContent.kind, id }, "FORBIDDEN");
  await fails("read_record_section", { kind: "bank_entry", id: 1 }, "FORBIDDEN");
});

async function introEdit(kind: "30s" | "2min" = "30s", texts = ["候选人已确认的介绍"]) {
  const current = await ok<{ versions: (Token & { kind: string })[] }>("get_intro", { id: 1 });
  const input = { introId: 1, kind, texts, expectedRevision: current.versions.find(row => row.kind === kind)!.revision };
  const preview = await ok<{ previewToken: string; changes: unknown[] }>("preview_intro_edit", input);
  return { ...input, previewToken: preview.previewToken, idempotencyKey: "preview-save-key" };
}

it("previews without writing, binds exact text and kind, preserves the other version and rejects corrupt originals", async () => {
  const edit = await introEdit();
  const existing = db.prepare("SELECT * FROM intro_versions ORDER BY id").all();
  expect(JSON.parse(String(existing[0]!.sentences))[0].text).toBe("原稿");
  await fails("save_intro_edit", { ...edit, texts: ["未经确认的稿"] }, "CONFLICT");
  await fails("save_intro_edit", { ...edit, kind: "2min" }, "CONFLICT");
  expect(db.prepare("SELECT * FROM intro_versions ORDER BY id").all()).toEqual(existing);
  await ok("save_intro_edit", edit); await ok("save_intro_edit", edit);
  expect(db.prepare("SELECT * FROM intro_versions WHERE kind='2min'").get()).toEqual(existing[1]);
  expect(await ok("get_intro", { id: 1 })).toMatchObject({ versions: [{ sentences: [{ text: edit.texts[0], comment: "" }] }, { sentences: [{ text: "长版", comment: "保留" }] }] });
  db.exec("UPDATE intro_versions SET sentences='[broken' WHERE kind='2min'");
  const versions = (await ok<{versions: (Token & { kind: string })[]}>("get_intro", { id: 1 })).versions;
  await fails("preview_intro_edit", { introId: 1, kind: "2min", texts: ["覆盖"], expectedRevision: versions[1]!.revision }, "INVALID_ARGUMENT");
  expect(db.prepare("SELECT sentences FROM intro_versions WHERE kind='2min'").get()).toEqual({ sentences: "[broken" });
});

it("pages a full preview without changing its confirmation token; a later Web edit wins", async () => {
  const texts = Array.from({ length: 55 }, (_, i) => `${i}：${"句".repeat(640)}`);
  const edit = await introEdit("30s", texts);
  const { previewToken, idempotencyKey, ...input } = edit;
  const lines: number[] = []; let cursor: string | null = null;
  do {
    const p: { previewToken: string; changes: { line: number; after: string }[]; nextCursor: string | null } = await ok("preview_intro_edit", { ...input, limit: 13, ...(cursor ? { cursor } : {}) });
    expect(p.previewToken).toBe(previewToken); lines.push(...p.changes.map(change => change.line));
    for (const change of p.changes) expect(change.after).toBe(texts[change.line - 1]);
    cursor = p.nextCursor;
  } while (cursor);
  expect(lines).toEqual(texts.map((_, i) => i + 1));
  const web = await import("@/app/api/intros/[id]/versions/[kind]/route");
  expect((await web.PATCH(req("PATCH", { baseRevision: input.expectedRevision, sentences: [{ text: "网页改稿", comment: "" }] }), params({ id: "1", kind: "30s" }))).status).toBe(200);
  await fails("save_intro_edit", { ...input, previewToken, idempotencyKey }, "CONFLICT");
  expect(db.prepare("SELECT sentences FROM intro_versions WHERE kind='30s'").get()).toEqual({ sentences: JSON.stringify([{ text: "网页改稿", comment: "" }]) });
});

it.each([
  { operation: "insert", texts: ["新增句", "第一句", "第二句", "第三句"], comments: ["", "评一", "评二", "评三"] },
  { operation: "delete", texts: ["第二句", "第三句"], comments: ["评二", "评三"] },
  { operation: "move", texts: ["第三句", "第一句", "第二句"], comments: ["评三", "评一", "评二"] },
  { operation: "edit", texts: ["第一句", "改写第二句", "第三句"], comments: ["评一", "", "评三"] },
])("preserves surviving intro comments after $operation", async ({ texts, comments }) => {
  const original = ["第一句", "第二句", "第三句"].map((text, i) => ({ text, comment: ["评一", "评二", "评三"][i] }));
  db.prepare("UPDATE intro_versions SET sentences=? WHERE kind='30s'").run(JSON.stringify(original));
  const edit = await introEdit("30s", texts);
  await ok("save_intro_edit", edit);
  const stored = JSON.parse(String(db.prepare("SELECT sentences FROM intro_versions WHERE kind='30s'").get()!.sentences));
  expect(stored).toEqual(texts.map((text, i) => ({ text, comment: comments[i] })));
  expect(db.prepare("SELECT sentences FROM intro_versions WHERE kind='2min'").get()).toEqual({ sentences: '[{"text":"长版","comment":"保留"}]' });
});

it("consumes duplicate intro occurrences once and preserves literal text", async () => {
  const original = [{ text: "  同句\n", comment: "第一次点评" }, { text: "  同句\n", comment: "第二次点评" }];
  db.prepare("UPDATE intro_versions SET sentences=? WHERE kind='30s'").run(JSON.stringify(original));
  const texts = ["新增句", ...original.map(row => row.text), original[0]!.text];
  await ok("save_intro_edit", await introEdit("30s", texts));
  expect(JSON.parse(String(db.prepare("SELECT sentences FROM intro_versions WHERE kind='30s'").get()!.sentences)))
    .toEqual(texts.map((text, i) => ({ text, comment: ["", "第一次点评", "第二次点评", ""][i] })));
});

it("preserves long pasted material exactly through both APIs; never accepts file provenance and does not attach twice", async () => {
  const create = { name: "材料项目", idempotencyKey: "create-project-key" };
  const { id } = await ok<{ id: number }>("create_project", create);
  expect(await ok("create_project", create)).toEqual({ id });
  const { project } = await ok<{ project: Token }>("get_project", { id });
  const content = "  \n[文件原文标记]🧪\r\n".repeat(3100);
  const input = { projectId: id, expectedRevision: project.revision, title: "记录", content, idempotencyKey: "append-material" };
  for (const malformed of ["部分\u0000内容", "\ud800", "   \n"]) await fails("add_project_material", { ...input, content: malformed }, "INVALID_ARGUMENT");
  for (const extra of [{ source: "file" }, { path: "C:/example.txt" }, { tableProvenance: { markers: [] } }]) await fails("add_project_material", { ...input, ...extra }, "INVALID_ARGUMENT");
  const created = await ok<{id: number}>("add_project_material", input);
  expect(await ok("add_project_material", input)).toEqual(created);
  expect(db.prepare("SELECT count(*) n FROM project_material_table_provenance").get()).toEqual({ n: 0 });
  const route = await import("@/app/api/projects/[id]/materials/[mid]/route");
  const response = await route.GET(req(), params({ id: String(id), mid: String(created.id) }));
  expect(await response.json()).toMatchObject({ content, source: "paste", filename: "" });
  const parts: string[] = []; let offset = 0, token: string | undefined;
  for (;;) {
    const part = await ok<{ nextOffset: number | null; revision: string; text: string }>("read_record_section", { kind: "project_material", id: created.id, offset, expectedRevision: token });
    parts.push(part.text); if (part.nextOffset === null) break;
    offset = part.nextOffset; token = part.revision;
  }
  expect(JSON.parse(parts.join(""))).toMatchObject({ content, source: "paste" });
  expect(parts.length).toBeGreaterThan(2);
  db.exec("UPDATE projects SET name='网页重新命名' WHERE id=1");
  await fails("add_project_material", { ...input, idempotencyKey: "changed-project" }, "CONFLICT");
  expect(db.prepare("SELECT count(*) n FROM project_materials").get()).toEqual({ n: 1 });
});

it("invalidates project grading context (including continuation reads) when source materials change", async () => {
  const questionId = seedDrill("project");
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','',''); UPDATE drills SET project_id=1");
  db.prepare("INSERT INTO project_materials (id,project_id,title,content,created_at) VALUES(1,1,'原文',?,'')").run("实际项目依据".repeat(1600));
  const input = await grade(questionId);
  const part = await ok<{nextOffset: number; revision: string}>("read_record_section", { kind: "practice_answer_context", id: questionId });
  expect(part.nextOffset).toBeGreaterThan(0);
  db.exec("UPDATE project_materials SET content='新的项目依据'");
  await fails("submit_practice_answer", input, "CONFLICT");
  await fails("read_record_section", { kind: "practice_answer_context", id: questionId, offset: part.nextOffset, expectedRevision: part.revision }, "CONFLICT");
});

it("invalidates project targets for hidden text, table provenance and Web deletion without relying on timestamps", async () => {
  const { createProjectMaterial } = await import("@/lib/project-materials");
  const { createDocumentTableProvenance } = await import("@/lib/document-table-provenance");
  const { id } = await ok<{ id: number }>("create_project", { name: "完整材料修订", idempotencyKey: "project-revision" });
  const content = "原始正文".repeat(600);
  const firstId = createProjectMaterial(id, { title: "旧文件", content, source: "file", filename: "source.docx" })!;
  for (let i = 0; i < 10; i++) createProjectMaterial(id, { title: String(i), content: "后续材料", source: "paste", filename: "" });
  const read = () => ok<{ project: Token; materials: { id: number }[] }>("get_project", { id });
  const before = await read();
  expect(before.materials.map(row => row.id)).not.toContain(firstId);
  const timestamps = db.prepare("SELECT created_at,updated_at FROM projects WHERE id=?").get(id);
  const changedText = content + "同毫秒补充";
  db.prepare("UPDATE project_materials SET content=? WHERE id=?").run(changedText, firstId);
  const changed = await read();
  expect(changed.project.revision).not.toBe(before.project.revision);
  db.prepare("INSERT INTO project_material_table_provenance(material_id,provenance) VALUES(?,?)")
    .run(firstId, JSON.stringify(createDocumentTableProvenance(changedText, [])));
  const extracted = await read();
  expect(extracted.project.revision).not.toBe(changed.project.revision);
  const web = await import("@/app/api/projects/[id]/materials/[mid]/route");
  expect((await web.DELETE(req("DELETE"), params({ id: String(id), mid: String(firstId) }))).status).toBe(200);
  expect((await read()).project.revision).not.toBe(extracted.project.revision);
  expect(db.prepare("SELECT created_at,updated_at FROM projects WHERE id=?").get(id)).toEqual(timestamps);
  await fails("add_project_material", { projectId: id, title: "过期提案", content: "不得追加", expectedRevision: extracted.project.revision, idempotencyKey: "stale-project-target" }, "CONFLICT");
  expect(db.prepare("SELECT count(*) n FROM project_materials WHERE project_id=?").get(id)).toEqual({ n: 10 });
});

it("includes DOCX table source and reading rules in both summary and full grading context", async () => {
  const { createDocumentTableProvenance } = await import("@/lib/document-table-provenance");
  const { createProjectMaterial } = await import("@/lib/project-materials");
  const { PROJECT_INTERVIEW_TABLE_DOCUMENT_RULES } = await import("@/lib/prompt-guidelines");
  db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'表格项目','','')");
  const questionId = seedDrill("project"); db.exec("UPDATE drills SET project_id=1");
  const content = "表格定位说明\n只参与测试，尚未上线。";
  createProjectMaterial(1, { title: "原始文档", content, source: "file", filename: "table.docx", tableProvenance: createDocumentTableProvenance(content, [{ start: 0, end: 6 }]) });
  const context = await ok<{ scoringRules: string }>("get_practice_answer_context", { questionId });
  expect(context.scoringRules).toContain(PROJECT_INTERVIEW_TABLE_DOCUMENT_RULES);
  let offset: number | null = 0, revision: string | undefined;
  const fragments: string[] = [];
  do {
    const part: { text: string; nextOffset: number | null; revision: string } = await ok("read_record_section", { kind: "practice_answer_context", id: questionId, offset, expectedRevision: revision });
    fragments.push(part.text); offset = part.nextOffset; revision = part.revision;
  } while (offset !== null);
  const full = JSON.parse(fragments.join(""));
  expect(full.scoringRules).toBe(context.scoringRules);
  expect(JSON.parse(full.projectContext).materials[0].tableDocument.segments[0].kind).toBe("table-layout");
});

it("validates mock turns and reports before advancing, refuses stale rounds, and supports explicit early finish", async () => {
  const { resume } = await ok<{resume: Token}>("get_resume", { id: 1, versionId });
  const start = { resumeId: 1, versionId, expectedRevision: resume.revision, jd: "存储开发", firstQuestion: "事务如何保证一致性？", rounds: 3, idempotencyKey: "single-mock-start" };
  const { id } = await ok<{id: number}>("start_mock_interview", start);
  expect(await ok("start_mock_interview", start)).toEqual({ id });
  const state = () => ok<Token & {currentTurnId: number; currentIndex: number}>("get_mock_interview_state", { interviewId: id });
  const first = await state();
  const turn = { interviewId: id, turnId: first.currentTurnId, expectedRevision: first.revision, answer: "对比最新版本再提交。", idempotencyKey: "mock-answer-key",
    evaluation: { ...scores, comment: "说明了提交条件。", next_kind: "question", next_question: "如何核对结果？" } };
  const end = { interviewId: id, expectedRevision: first.revision, idempotencyKey: "mock-finish-key", report: { jd_match: 7, strengths: "说明了版本校验。", weaknesses: "未述锁竞争。", suggestions: "补充一个并发例子。" } };
  await fails("finish_mock_interview", end, "INVALID_ARGUMENT");
  await fails("answer_mock_interview", { ...turn, evaluation: { ...turn.evaluation, depth: 5.5 } }, "INVALID_ARGUMENT");
  await fails("answer_mock_interview", { ...turn, evaluation: { ...turn.evaluation, next_question: start.firstQuestion } }, "INVALID_ARGUMENT");
  expect(await state()).toMatchObject({ revision: first.revision, answered: 0 });
  await ok("answer_mock_interview", turn);
  await fails("answer_mock_interview", { ...turn, idempotencyKey: "other-turn-key" }, "CONFLICT");
  const second = await state();
  expect(second).toMatchObject({ currentIndex: 2, answered: 1 });
  await fails("finish_mock_interview", end, "CONFLICT");
  const finish = { ...end, expectedRevision: second.revision };
  await fails("finish_mock_interview", { ...finish, report: { ...end.report, jd_match: 19 } }, "INVALID_ARGUMENT");
  await ok("finish_mock_interview", finish); await ok("finish_mock_interview", finish);
  await fails("finish_mock_interview", { ...finish, expectedRevision: (await state()).revision, idempotencyKey: "different-report" }, "CONFLICT");
  expect(await state()).toMatchObject({ currentTurnId: null, answered: 1, reportSaved: true });
  db.exec("INSERT INTO interview_series(id,resume_id,jd,created_at) VALUES(1,1,'系列',''); UPDATE interviews SET series_id=1,round_no=1");
  await fails("get_mock_interview_state", { interviewId: id }, "INVALID_ARGUMENT");
});

it("archives a mining report with unknown facts left empty, while refusing empty or invalid reports", async () => {
  const { resume } = await ok<{ resume: Token }>("get_resume", { id: 1, versionId });
  const { id } = await ok<{ id: number }>("start_mock_interview", { resumeId: 1, versionId, expectedRevision: resume.revision,
    jd: "维护测试", style: "mining", rounds: 1, firstQuestion: "请说明能确认的工作范围。", idempotencyKey: "mining-start" });
  const state = () => ok<Token & { currentTurnId: number; reportSaved: boolean }>("get_mock_interview_state", { interviewId: id });
  const first = await state();
  await ok("answer_mock_interview", { interviewId: id, turnId: first.currentTurnId, expectedRevision: first.revision,
    answer: "我参与测试，但记不清项目名，也不知道发布结果。", evaluation: { ...scores, comment: "明确了事实边界。", next_kind: "question", next_question: "" }, idempotencyKey: "mining-answer" });
  const report = { jd_match: 7, strengths: "明确分工。", weaknesses: "结果尚不确定。", suggestions: "核对发布记录。",
    mining_summary: { project_name: "", background: "", actions: "参与测试。", tradeoffs: "", results: "", contribution: "参与测试。",
      pending_confirmations: [{ category: "结果", item: "发布状态", source_hint: "核对发布记录" }], resume_bullets: [] } };
  const input = { interviewId: id, expectedRevision: (await state()).revision, report, idempotencyKey: "mining-report" };
  await fails("finish_mock_interview", { ...input, report: { ...report, mining_summary: { ...report.mining_summary, actions: "", contribution: "", pending_confirmations: [] } } }, "INVALID_ARGUMENT");
  await fails("finish_mock_interview", { ...input, report: { ...report, mining_summary: { ...report.mining_summary, actions: "。" } } }, "INVALID_ARGUMENT");
  expect((await state()).reportSaved).toBe(false);
  expect(await ok("finish_mock_interview", input)).toEqual({ id });
  expect(await ok("finish_mock_interview", input)).toEqual({ id });
  const web = await import("@/app/api/interviews/[id]/route");
  expect(await (await web.GET(req(), params({ id: String(id) }))).json()).toMatchObject({ status: "finished", report: { depth: scores.depth, mining_summary: report.mining_summary } });
});
