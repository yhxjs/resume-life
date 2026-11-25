import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer, versionId: number;
type Bag = Record<string, unknown>;
type Section = { revision: string; nextOffset: number | null; text: string; totalLength: number; previewToken?: string };
async function ok<T = Bag>(name: string, args: Bag = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return (result.structuredContent as { data: T }).data;
}
async function fails(name: string, args: Bag, code: string) {
  expect((await client.callTool({ name, arguments: args })).structuredContent).toMatchObject({ ok: false, error: { code } });
}
async function context(name: string, args: Bag, preview = false) {
  let page = await ok<Section>(name, args), text = page.text;
  const revision = page.revision, previewToken = page.previewToken;
  while (page.nextOffset !== null) {
    const next = { offset: page.nextOffset, expectedRevision: revision };
    page = await ok<Section>(name, { ...args, ...(preview ? { page: next } : next) }); text += page.text;
  }
  expect(text.length).toBe(page.totalLength);
  return { revision, previewToken, value: JSON.parse(text) };
}
async function connect(allowlist: Set<string> | null = null, writeEnabled = true) {
  await client?.close(); await server?.close();
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist, writeEnabled, llmEnabled: false, timeoutMs: 60_000 });
  client = new Client({ name: "content-generation", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-content-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory); db = (await import("@/lib/db")).getDb();
  db.exec(`INSERT INTO resumes(id,title,created_at,updated_at) VALUES(1,'固定履历','','');
    INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'skills','skills','技能',0,'{"items":["SQLite"]}','');
    INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'数据工具','','');
    INSERT INTO project_materials(id,project_id,title,content,created_at) VALUES(1,1,'事实材料','参与数据工具的 SQLite 校验。','')`);
  versionId = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "固定版" }).id;
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-content-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
const source = () => ({ mode: "create", resumeId: 1, versionId, jd: "后端开发，使用 SQLite。" });
const versions = [{ kind: "30s", sentences: [{ text: "我接触过 SQLite。", comment: "保留了技能程度。" }] },
  { kind: "2min", sentences: [{ text: "我接触过 SQLite，希望应聘后端开发岗位。", comment: "区分技能事实与求职意向。" }] }];
async function introInput() {
  const value = source();
  return { source: value, expectedRevision: (await context("get_intro_generation_context", { source: value })).revision,
    result: { versions }, idempotencyKey: "new-intro-fixture" };
}
const summary = { overview: "数据工具", architecture: "使用 SQLite", highlights: "", responsibilities: "参与校验", challenges: "",
  techStack: "SQLite", brief: "数据校验工具", achievements: ["参与 SQLite 校验。"] };
async function summaryInput() {
  return { projectId: 1, mode: "full", expectedRevision: (await context("get_project_summary_context", { projectId: 1 })).revision, result: summary };
}

it("creates both intro versions, regenerates one, saves comments and reads the same records on the Web", async () => {
  const llm = await import("@/lib/safe-llm"), chat = vi.spyOn(llm, "safeChat"), stream = vi.spyOn(llm, "safeChatStream");
  const input = await introInput(), created = await ok<{ id: number }>("save_generated_intro", input);
  await connect(); expect(await ok("save_generated_intro", input)).toEqual(created);
  const regen = { mode: "regenerate", introId: created.id, kind: "30s" };
  const result = { versions: [{ kind: "30s", sentences: [{ text: "我接触过 SQLite，希望应聘后端岗位。", comment: "事实和意向分别表达。" }] }] };
  await ok("save_generated_intro", { source: regen, expectedRevision: (await context("get_intro_generation_context", { source: regen })).revision,
    result, idempotencyKey: "regen-intro-fixture" });
  const comment = { mode: "comment", introId: created.id, kind: "30s" };
  await ok("save_intro_comments", { introId: created.id, kind: "30s", expectedRevision: (await context("get_intro_generation_context", { source: comment })).revision,
    comments: ["正文按原有事实表达。"], idempotencyKey: "intro-comments-fixture" });
  const web = await import("@/app/api/intros/[id]/route");
  const response = await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: String(created.id) }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ resume_version_id: versionId, versions: [
    { kind: "30s", sentences: [{ text: result.versions[0]!.sentences[0]!.text, comment: "正文按原有事实表达。" }] }, versions[1],
  ] });
  expect(chat).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
});

it("rejects incomplete generation and stale comments without creating half an intro or replacing text", async () => {
  const input = await introInput();
  await fails("save_generated_intro", { ...input, result: { versions: [versions[0]] } }, "INVALID_ARGUMENT");
  expect(db.prepare("SELECT count(*) n FROM intros").get()).toEqual({ n: 0 });
  const created = await ok<{ id: number }>("save_generated_intro", input);
  const source = { mode: "comment", introId: created.id, kind: "30s" };
  const expectedRevision = (await context("get_intro_generation_context", { source })).revision;
  db.prepare("UPDATE intros SET jd=? WHERE id=?").run("新的 JD", created.id);
  await fails("save_intro_comments", { introId: created.id, kind: "30s", expectedRevision, comments: ["旧点评"], idempotencyKey: "stale-comments" }, "CONFLICT");
  expect((await ok<{ versions: unknown[] }>("get_intro", { id: created.id })).versions[0]).toMatchObject(versions[0]!);
});

it("keeps creation bound to the selected published version and rolls back both versions on storage failure", async () => {
  const input = await introInput();
  db.exec("UPDATE resume_modules SET content='{\"items\":[\"新的草稿技能\"]}'");
  await (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "另一发布版" });
  db.exec("CREATE TRIGGER fail_intro BEFORE INSERT ON intro_versions WHEN NEW.kind='2min' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await fails("save_generated_intro", input, "INTERNAL");
  expect(db.prepare("SELECT count(*) n FROM intros").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_intro");
  const created = await ok<{ id: number }>("save_generated_intro", input);
  expect(await ok("get_intro", { id: created.id })).toMatchObject({ resume_version_id: versionId });
});

it("previews selected summary changes, archives once and exposes identical Web history", async () => {
  const input = { ...await summaryInput(), acceptedKeys: ["overview", "architecture"] };
  const preview = await context("preview_project_summary", input, true);
  expect(preview.value.savedSummary).toMatchObject({ overview: summary.overview, architecture: summary.architecture, responsibilities: "" });
  const save = { ...input, previewToken: preview.previewToken, idempotencyKey: "save-summary-fixture" };
  const saved = await ok<{ id: number }>("save_project_summary", save);
  await connect(); expect(await ok("save_project_summary", save)).toEqual(saved);
  expect(await ok("list_project_summary_history", { projectId: 1 })).toMatchObject({ items: [{ id: saved.id, source: "ai" }] });
  const web = await import("@/app/api/projects/[id]/route");
  expect(await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: "1" }) })).json())
    .toMatchObject({ summary: preview.value.savedSummary, summary_revision_id: saved.id });
  const history = await ok<Section>("read_record_section", { kind: "project_summary_history", id: saved.id });
  expect(JSON.parse(history.text)).toMatchObject({ project_id: 1, summary: JSON.stringify(preview.value.savedSummary) });
});

it("rejects changed preview proposals and material edits, including same-timestamp edits", async () => {
  const input = await summaryInput(), preview = await context("preview_project_summary", input, true);
  const save = { ...input, previewToken: preview.previewToken, idempotencyKey: "conflicting-summary" };
  await fails("save_project_summary", { ...save, acceptedKeys: ["overview"] }, "CONFLICT");
  db.exec("UPDATE project_materials SET content='新材料' WHERE id=1");
  await fails("save_project_summary", save, "CONFLICT");
  expect(db.prepare("SELECT count(*) n FROM project_summary_history").get()).toEqual({ n: 0 });
});

it("reads long Unicode materials losslessly and invalidates a continued context when the material changes", async () => {
  const material = '项目材料😀 "换行"\n'.repeat(8500);
  db.prepare("UPDATE project_materials SET content=? WHERE id=1").run(material);
  const value = await context("get_project_summary_context", { projectId: 1 });
  expect(value.value.untrusted.materialText).toContain(JSON.stringify(material).slice(1, -1));
  const first = await ok<Section>("get_project_summary_context", { projectId: 1, length: 31 });
  db.exec("UPDATE projects SET name='更新的名称' WHERE id=1");
  await fails("get_project_summary_context", { projectId: 1, offset: first.nextOffset, expectedRevision: first.revision }, "CONFLICT");
});

it("requires each workflow source capability and denies write tools in a read-only configuration", async () => {
  const input = await introInput();
  await connect(new Set(["get_intro_generation_context"]));
  await fails("get_intro_generation_context", { source: source() }, "FORBIDDEN");
  await connect(new Set(["get_project_summary_context", "get_project"]));
  await fails("get_project_summary_context", { projectId: 1 }, "FORBIDDEN");
  await connect(null, false); await fails("save_generated_intro", input, "FORBIDDEN");
});

it.each(["project", "job"])("creates %s questions, grades, bookmarks and reviews through existing tools", async kind => {
  const source = kind === "project" ? { kind, projectId: 1, jd: "SQLite 开发", count: 2 } : { kind, jd: "SQLite 开发", count: 2 };
  const result = { questions: kind === "project" ? ["你参与了哪些 SQLite 校验？"] : [{ kind: "tech", question: "SQLite 如何保证事务原子性？" }] };
  const input = { source, result, expectedRevision: (await context("get_practice_generation_context", { source })).revision, idempotencyKey: "generated-practice" };
  const saved = await ok<{ id: number }>("save_generated_practice", input);
  await connect(); expect(await ok("save_generated_practice", input)).toEqual(saved);
  const list = await ok<{ items: { id: number }[] }>("list_practice_questions", { drillId: saved.id });
  const questionId = list.items[0]!.id;
  const basis = await ok<{ revision: string }>("get_practice_answer_context", { questionId });
  await ok("submit_practice_answer", { questionId, expectedRevision: basis.revision, idempotencyKey: "generated-practice-answer", answer: "我检查了事务回滚。",
    evaluation: { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "交代了校验内容。", reference: "补充校验方法。" } });
  await ok("bookmark_practice_question", { source: "drill", sourceId: questionId, idempotencyKey: "generated-practice-bookmark" });
  expect(db.prepare("SELECT count(*) n FROM notebook_entries").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT count(*) n FROM review_cards").get()).toEqual({ n: 1 });
  const web = await import("@/app/api/drills/[id]/route");
  expect(await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: String(saved.id) }) })).json())
    .toMatchObject({ jd: "SQLite 开发", questions: [{ answer: "我检查了事务回滚。" }] });
});

it("uses full original interview answers for remediation and rejects old questions or stale reports", async () => {
  const report = { depth: 5, structure: 6, authenticity: 7, completeness: 5, jd_match: 6, strengths: "说明校验内容", weaknesses: "需要补充过程", suggestions: "练习说明校验步骤" };
  db.prepare("INSERT INTO interviews(id,resume_id,resume_version_id,jd,status,report,created_at) VALUES(1,1,?,'SQLite 开发','finished',?,'')").run(versionId, JSON.stringify(report));
  db.exec("INSERT INTO interview_turns(interview_id,idx,question,answer,answered_at) VALUES(1,1,'如何校验事务？','我检查了回滚。','saved')");
  const source = { kind: "interview", interviewId: 1, count: 2 }, basis = await context("get_practice_generation_context", { source });
  expect(basis.value.untrusted.answers).toEqual([{ idx: 1, kind: "question", answer: "我检查了回滚。" }]);
  const input = { source, expectedRevision: basis.revision, idempotencyKey: "interview-remediation", result: { questions: [{ question: "如何校验事务？", kind: "tech" }] } };
  await fails("save_generated_practice", input, "INVALID_ARGUMENT");
  const result = { questions: [{ question: "假设提交时断电，你会如何验证恢复结果？", kind: "tech" }] };
  const saved = await ok<{ id: number }>("save_generated_practice", { ...input, result });
  expect(db.prepare("SELECT source,interview_id,jd FROM drills WHERE id=?").get(saved.id)).toEqual({ source: "interview", interview_id: 1, jd: "SQLite 开发" });
  db.exec("UPDATE interview_turns SET answer='更新了原答' WHERE interview_id=1");
  await fails("save_generated_practice", { ...input, result, idempotencyKey: "stale-interview-remediation" }, "CONFLICT");
});

it("rejects repeated generated questions and a project changed after context capture", async () => {
  const source = { kind: "project", projectId: 1, count: 2 };
  const input = { source, expectedRevision: (await context("get_practice_generation_context", { source })).revision,
    result: { questions: ["如何进行校验？", "如何进行校验？"] }, idempotencyKey: "invalid-generated-practice" };
  await fails("save_generated_practice", input, "INVALID_ARGUMENT");
  db.exec("UPDATE project_materials SET content='变更材料' WHERE id=1");
  await fails("save_generated_practice", { ...input, result: { questions: ["如何进行校验？"] } }, "CONFLICT");
  expect(db.prepare("SELECT count(*) n FROM drills").get()).toEqual({ n: 0 });
});

it("grades generated project questions with complete long materials and preserves Web model limits", async () => {
  const material = '参与 SQLite 校验。😀 "原文"\n'.repeat(4000) + "末尾依据：仅参与回滚校验，尚未上线。";
  db.prepare("UPDATE project_materials SET content=? WHERE id=1").run(material);
  const source = { kind: "project", projectId: 1, count: 1 };
  const generated = await context("get_practice_generation_context", { source });
  expect(generated.value.untrusted.projectContext.length).toBeGreaterThan(64_000);
  const saved = await ok<{ id: number }>("save_generated_practice", { source, expectedRevision: generated.revision,
    result: { questions: ["你参与了哪些回滚校验？"] }, idempotencyKey: "long-project-practice" });
  const questionId = (await ok<{ items: { id: number }[] }>("list_practice_questions", { drillId: saved.id })).items[0]!.id;
  const summary = await ok<{ revision: string; truncated: boolean }>("get_practice_answer_context", { questionId });
  expect(summary.truncated).toBe(true);
  const complete = await context("read_record_section", { kind: "practice_answer_context", id: questionId });
  expect(complete.value.revision).toBe(summary.revision);
  expect(complete.value.projectContext).toBe(generated.value.untrusted.projectContext);
  expect(JSON.parse(complete.value.projectContext).materials[0].content).toBe(material);

  const { loadDrillGrade } = await import("@/lib/drill-grading");
  await expect(loadDrillGrade(questionId, saved.id)).rejects.toThrow("40000");
  const input = { questionId, expectedRevision: summary.revision, idempotencyKey: "long-project-answer",
    answer: "我只参与了回滚校验，尚未上线。", evaluation: { depth: 7, structure: 8, authenticity: 8, completeness: 7,
      comment: "交代了参与范围和验证状态。", reference: "说明本人参与的回滚校验与结果，保留尚未上线的限定。" } };
  const answer = await ok("submit_practice_answer", input);
  await connect(); expect(await ok("submit_practice_answer", input)).toEqual(answer);
  await ok("bookmark_practice_question", { source: "drill", sourceId: questionId, idempotencyKey: "long-project-bookmark" });
  const web = await import("@/app/api/drills/[id]/route");
  expect(await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: String(saved.id) }) })).json())
    .toMatchObject({ questions: [{ answer: input.answer, comment: input.evaluation.comment, reference: input.evaluation.reference }] });
  expect(db.prepare("SELECT count(*) n FROM notebook_entries").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT count(*) n FROM review_cards").get()).toEqual({ n: 1 });
});

it.each(["same-length", "longer"])("rejects %s changes beyond a long grading context's first page", async change => {
  const material = "参与 SQLite 校验。".repeat(6000) + "原始结尾";
  db.prepare("UPDATE project_materials SET content=? WHERE id=1").run(material);
  db.exec("INSERT INTO drills(id,source,project_id,created_at) VALUES(1,'project',1,''); INSERT INTO drill_questions(id,drill_id,idx,question) VALUES(1,1,1,'你参与了哪些校验？')");
  const basis = await ok<{ revision: string }>("get_practice_answer_context", { questionId: 1 });
  const page = await ok<Section>("read_record_section", { kind: "practice_answer_context", id: 1 });
  const input = { questionId: 1, expectedRevision: basis.revision, idempotencyKey: "changed-long-answer", answer: "我参与了回滚校验。",
    evaluation: { depth: 6, structure: 7, authenticity: 8, completeness: 6, comment: "说明了本人参与的内容。", reference: "补充校验方式。" } };
  const before = db.prepare("SELECT * FROM drill_questions WHERE id=1").get();
  db.prepare("UPDATE project_materials SET content=? WHERE id=1").run(change === "same-length" ? material.slice(0, -4) + "变更结尾" : material + "补充说明");
  await fails("read_record_section", { kind: "practice_answer_context", id: 1, offset: page.nextOffset, expectedRevision: page.revision }, "CONFLICT");
  await fails("submit_practice_answer", input, "CONFLICT");
  expect(db.prepare("SELECT * FROM drill_questions WHERE id=1").get()).toEqual(before);
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
  const fresh = await context("read_record_section", { kind: "practice_answer_context", id: 1 });
  await ok("submit_practice_answer", { ...input, expectedRevision: fresh.value.revision });
});

it("discovers unlinked preparation records and bank directions with stable cursors and literal filtering", async () => {
  const saved = await ok<{ id: number }>("save_generated_intro", await introInput());
  db.exec("INSERT INTO jd_portraits(id,jd,result,created_at) VALUES(1,'SQLite 开发','{}',''); INSERT INTO bank_entries(direction,kind,question,created_at) VALUES('后端','tech','事务？',''),('后端','behavior','协作？',''),('前端','tech','组件？','')");
  expect(await ok("list_intros", { q: "SQLite", resumeId: 1 })).toMatchObject({ items: [{ id: saved.id }] });
  expect(await ok("list_jd_portraits", { q: "SQLite" })).toMatchObject({ items: [{ id: 1 }] });
  expect(await ok("list_intros", { q: "%" })).toMatchObject({ items: [] });
  const first = await ok<{ items: unknown[]; nextCursor: string }>("list_bank_directions", { limit: 1 });
  expect(first.items).toEqual([{ id: 3, direction: "前端", count: 1 }]);
  expect(await ok("list_bank_directions", { cursor: first.nextCursor })).toMatchObject({ items: [{ direction: "后端", count: 2 }], nextCursor: null });
});

const blankInterviewInputs = ["", "  \n\t  ", "\u00a0\u3000"];
function interviewRecords() {
  return Object.fromEntries(["interview_series", "interviews", "interview_turns", "mcp_creation_receipts"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

it.each(["single", "series"])("rejects blank %s interview JDs without creating sessions or receipts", async kind => {
  const source = { kind: "create", resumeId: 1, versionId, jd: "SQLite 开发", rounds: 1 };
  const resume = await ok<{ resume: { revision: string } }>("get_resume", { id: 1, versionId });
  const expectedRevision = kind === "single" ? resume.resume.revision
    : (await context("get_interview_series_context", { source })).revision;
  const before = interviewRecords();
  for (const jd of blankInterviewInputs) {
    if (kind === "single") {
      await fails("start_mock_interview", { resumeId: 1, versionId, expectedRevision, jd, rounds: 1,
        firstQuestion: "你如何校验事务回滚？", idempotencyKey: "blank-jd" }, "INVALID_ARGUMENT");
    } else {
      await fails("get_interview_series_context", { source: { ...source, jd } }, "INVALID_ARGUMENT");
      await fails("save_interview_series_result", { source: { ...source, jd }, expectedRevision,
        result: { question: "你如何校验事务回滚？" }, idempotencyKey: "blank-jd" }, "INVALID_ARGUMENT");
    }
    expect(interviewRecords()).toEqual(before);
  }
});

it.each(["single", "series"])("rejects blank %s answers without grading or advancing and permits a corrected retry", async kind => {
  let interviewId: number, seriesId: number | undefined;
  if (kind === "single") {
    const resume = await ok<{ resume: { revision: string } }>("get_resume", { id: 1, versionId });
    interviewId = (await ok<{ id: number }>("start_mock_interview", { resumeId: 1, versionId,
      expectedRevision: resume.resume.revision, jd: "SQLite 开发", rounds: 1,
      firstQuestion: "你如何校验事务回滚？", idempotencyKey: "blank-answer-session" })).id;
  } else {
    const source = { kind: "create", resumeId: 1, versionId, jd: "SQLite 开发", rounds: 1 };
    seriesId = (await ok<{ id: number }>("save_interview_series_result", { source,
      expectedRevision: (await context("get_interview_series_context", { source })).revision,
      result: { question: "你如何校验事务回滚？" }, idempotencyKey: "blank-answer-session" })).id;
    interviewId = (await ok<{ interviews: { id: number }[] }>("get_interview_series", { id: seriesId })).interviews[0]!.id;
  }
  const target = { interviewId, ...(seriesId === undefined ? {} : { seriesId }) };
  const stateTool = kind === "single" ? "get_mock_interview_state" : "get_series_interview_state";
  const answerTool = kind === "single" ? "answer_mock_interview" : "answer_series_interview";
  const state = await ok<{ revision: string; currentTurnId: number }>(stateTool, target);
  const input = { ...target, turnId: state.currentTurnId, expectedRevision: state.revision, idempotencyKey: "blank-answer",
    evaluation: { depth: 10, structure: 10, authenticity: 10, completeness: 10, comment: "评价原答。", next_kind: "question", next_question: "" } };
  const before = interviewRecords();
  for (const answer of blankInterviewInputs) {
    await fails(answerTool, { ...input, answer }, "INVALID_ARGUMENT");
    expect(interviewRecords()).toEqual(before);
    expect(await ok(stateTool, target)).toEqual(state);
  }
  const corrected = { ...input, answer: "  我检查了事务回滚。\n" };
  const saved = await ok(answerTool, corrected);
  await connect(); expect(await ok(answerTool, corrected)).toEqual(saved);
  expect(db.prepare("SELECT answer FROM interview_turns WHERE id=?").get(state.currentTurnId))
    .toEqual({ answer: "我检查了事务回滚。" });
  expect(await ok(stateTool, target)).toMatchObject({ answered: 1, status: "finished" });
});

it("guards shared interview writes against blank inputs and rolls back the enclosing series transaction", async () => {
  const { createInterviewSeriesRecord } = await import("@/lib/interview-series-store");
  const { createInterviewSession, commitInterviewTurn } = await import("@/lib/interview-session-store");
  const { answerMockInterview, readMockState } = await import("@/lib/mcp-mock-interview");
  const { classifyMcpError } = await import("@/lib/mcp-errors");
  const input = { resumeId: 1, versionId, jd: "SQLite 开发", rounds: 1, question: "你如何校验事务回滚？", at: "fixture" };
  const empty = interviewRecords();
  expect(() => createInterviewSeriesRecord({ ...input, jd: " \n " })).toThrow(expect.objectContaining({ status: 400 }));
  expect(interviewRecords()).toEqual(empty);
  const interviewId = createInterviewSession({ ...input, style: "gentle", seriesId: null, roundNo: 0 });
  const state = readMockState(interviewId), before = interviewRecords();
  const turn = { id: state.currentTurnId!, idx: 1, question: input.question };
  const scores = { depth: 10, structure: 10, authenticity: 10, completeness: 10 };
  expect(() => commitInterviewTurn({ interviewId, turn, answer: " \n ", scores, comment: "评价原答。",
    finished: true, nextKind: "question", nextQuestion: "" })).toThrow(expect.objectContaining({ status: 400 }));
  expect(interviewRecords()).toEqual(before);
  try {
    answerMockInterview({ interviewId, turnId: turn.id, expectedRevision: state.revision, answer: " \n ",
      evaluation: { ...scores, comment: "评价原答。", next_kind: "question", next_question: "" }, idempotencyKey: "domain-blank-answer" });
    expect.fail("blank domain answer should be rejected");
  } catch (error) {
    expect(classifyMcpError(error)).toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  expect(interviewRecords()).toEqual(before);
});

async function startMock() {
  const resume = await ok<{ resume: { revision: string } }>("get_resume", { id: 1, versionId });
  const mock = await ok<{ id: number }>("start_mock_interview", { resumeId: 1, versionId, expectedRevision: resume.resume.revision, jd: "SQLite 开发",
    rounds: 1, firstQuestion: "你如何校验事务回滚？", idempotencyKey: "create-mock-training" });
  const state = await ok<{ revision: string; currentTurnId: number }>("get_mock_interview_state", { interviewId: mock.id });
  await ok("answer_mock_interview", { interviewId: mock.id, turnId: state.currentTurnId, expectedRevision: state.revision, answer: "我检查了回滚。", idempotencyKey: "mock-original",
    evaluation: { depth: 5, structure: 6, authenticity: 7, completeness: 5, comment: "说明了校验对象。", next_kind: "question", next_question: "" } });
  return { id: mock.id, turnId: state.currentTurnId };
}

it("keeps retry scores separate, saves reference and reverse interview, and computes the report from original answers", async () => {
  const mock = await startMock();
  const source = { kind: "retry", interviewId: mock.id, turnId: mock.turnId, answer: "我用故障注入校验回滚，并核对数据一致性。" };
  const input = { source, expectedRevision: (await context("get_interview_training_context", { source })).revision, idempotencyKey: "training-retry",
    result: { depth: 9, structure: 9, authenticity: 9, completeness: 9, comment: "补充了校验方法。", reference: "明确故障场景和断言。" } };
  await ok("save_interview_training_result", input); await connect(); await ok("save_interview_training_result", input);
  const turn = db.prepare("SELECT answer,scores,retries,reference FROM interview_turns WHERE id=?").get(mock.turnId) as { answer: string; scores: string; retries: string; reference: string };
  expect(turn.answer).toBe("我检查了回滚。"); expect(JSON.parse(turn.scores).depth).toBe(5); expect(JSON.parse(turn.retries)).toHaveLength(1); expect(turn.reference).toBe("");
  const ref = { kind: "reference", interviewId: mock.id, turnId: mock.turnId };
  await ok("save_interview_training_result", { source: ref, expectedRevision: (await context("get_interview_training_context", { source: ref })).revision,
    result: { reference: "依据题目选择故障注入和数据校验。" }, idempotencyKey: "training-reference" });
  const reverse = { kind: "reverse", interviewId: mock.id, question: "团队通常如何确认数据质量？" };
  const reversed = { source: reverse, expectedRevision: (await context("get_interview_training_context", { source: reverse })).revision,
    result: { answer: "具体流程需向实际团队核实。", evaluation: { score: 8, insight: "关注岗位相关协作。", feedback: "问题明确。", suggestions: "可询问入职后的协作分工。" } }, idempotencyKey: "training-reverse" };
  await ok("save_interview_training_result", reversed); await ok("save_interview_training_result", reversed);
  const state = await ok<{ revision: string }>("get_mock_interview_state", { interviewId: mock.id });
  await ok("finish_mock_interview", { interviewId: mock.id, expectedRevision: state.revision, idempotencyKey: "training-report",
    report: { jd_match: 6, strengths: "说明校验对象。", weaknesses: "原答缺少方法。", suggestions: "练习解释方法。" } });
  const web = await import("@/app/api/interviews/[id]/route");
  const record = await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: String(mock.id) }) })).json();
  expect(record).toMatchObject({ report: { depth: 5 }, reverse_interview: { evaluation: { score: 8, level: "优秀" } },
    turns: [{ answer: "我检查了回滚。", reference: "依据题目选择故障注入和数据校验。", retries: [{ answer: source.answer, scores: { depth: 9 } }] }] });
  await fails("get_interview_training_context", { source: reverse }, "CONFLICT");
});

it("rejects a stale training result when original or followup context changes", async () => {
  const mock = await startMock();
  const source = { kind: "reference", interviewId: mock.id, turnId: mock.turnId };
  const basis = await context("get_interview_training_context", { source });
  db.prepare("UPDATE interview_turns SET question='新的题目' WHERE id=?").run(mock.turnId);
  await fails("save_interview_training_result", { source, expectedRevision: basis.revision, result: { reference: "过期参考" }, idempotencyKey: "stale-reference" }, "CONFLICT");
  await fails("get_interview_training_context", { source: { ...source, interviewId: 12345 } }, "NOT_FOUND");
});

it("creates, reconnects, completes and finalizes all three series rounds without duplicate advancement", async () => {
  const source = { kind: "create", resumeId: 1, versionId, jd: "SQLite 开发", rounds: 1 };
  const createdInput = { source, expectedRevision: (await context("get_interview_series_context", { source })).revision,
    result: { question: "如何设计事务校验？" }, idempotencyKey: "create-series" };
  const { id: seriesId } = await ok<{ id: number }>("save_interview_series_result", createdInput);
  await connect(); expect(await ok("save_interview_series_result", createdInput)).toEqual({ id: seriesId });
  const series = await ok<{ interviews: { id: number }[] }>("get_interview_series", { id: seriesId });
  let interviewId = series.interviews[0]!.id;
  for (let round = 1; round <= 3; round++) {
    await fails("get_mock_interview_state", { interviewId }, "INVALID_ARGUMENT");
    const state = await ok<{ revision: string; currentTurnId: number }>("get_series_interview_state", { seriesId, interviewId });
    await ok("answer_series_interview", { seriesId, interviewId, turnId: state.currentTurnId, expectedRevision: state.revision, answer: `第 ${round} 轮真实回答`, idempotencyKey: `series-answer-${round}`,
      evaluation: { depth: 6, structure: 7, authenticity: 8, completeness: 6, comment: "具体说明了做法。", next_kind: "question", next_question: "" } });
    const answered = await ok<{ revision: string }>("get_series_interview_state", { seriesId, interviewId });
    await ok("finish_series_interview", { seriesId, interviewId, expectedRevision: answered.revision, idempotencyKey: `series-report-${round}`,
      report: { jd_match: 7, strengths: "解释具体。", weaknesses: "可补充验证。", suggestions: "练习说明验证方法。" } });
    if (round < 3) {
      const source = { kind: "advance", seriesId, fromInterviewId: interviewId };
      const input = { source, expectedRevision: (await context("get_interview_series_context", { source })).revision,
        result: { question: round === 1 ? "如何协调校验计划？" : "你希望怎样的团队协作方式？" }, idempotencyKey: `series-advance-${round}` };
      const next = await ok<{ id: number }>("save_interview_series_result", input);
      expect(await ok("save_interview_series_result", input)).toEqual(next);
      await fails("save_interview_series_result", { ...input, idempotencyKey: `duplicate-advance-${round}` }, "CONFLICT");
      interviewId = next.id;
    }
  }
  const finalSource = { kind: "finalize", seriesId };
  const finalInput = { source: finalSource, expectedRevision: (await context("get_interview_series_context", { source: finalSource })).revision,
    result: { verdict: "三轮表现具备基础。", strengths: "表达具体。", weaknesses: "验证细节不足。", suggestions: "补充验证方法。" }, idempotencyKey: "finalize-series" };
  await ok("save_interview_series_result", finalInput); await connect(); await ok("save_interview_series_result", finalInput);
  const final = await ok<{ final_report: string; interviews: unknown[] }>("get_interview_series", { id: seriesId });
  expect(final.interviews).toHaveLength(3); expect(JSON.parse(final.final_report)).toMatchObject({ verdict: finalInput.result.verdict, overall: 6.8 });
  expect(await ok("list_interview_series", { q: "SQLite" })).toMatchObject({ items: [{ id: seriesId, status: "finished" }] });
});

it("creates and copies resume drafts, previews module edits and preserves published and submitted snapshots", async () => {
  const created = await ok<{ id: number }>("create_resume_draft", { title: "新草稿", idempotencyKey: "empty-resume" });
  expect(await ok("get_resume", { id: created.id })).toMatchObject({ resume: { title: "新草稿" } });
  const beforeVersion = db.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId);
  await ok("create_application", { company: "公司", role: "后端", stage: "applied", resume_id: 1, resume_version_id: versionId,
    jd: "SQLite 开发", idempotencyKey: "resume-snapshot-application" });
  const beforeSubmission = db.prepare("SELECT * FROM applications").all();
  const basis = await context("get_resume_draft_context", { resumeId: 1 });
  const copyInput = { title: "岗位草稿", source: { resumeId: 1, expectedRevision: basis.revision }, idempotencyKey: "copy-resume" };
  const copy = await ok<{ id: number }>("create_resume_draft", copyInput);
  expect(await ok("create_resume_draft", copyInput)).toEqual(copy);
  const input = { resumeId: 1, expectedRevision: basis.revision, title: "修改的草稿", modules: [
    { key: "skills", type: "skills", label: "技能", content: { items: ["SQLite 事务校验"] } },
    { key: "mod_evidence", type: "custom", label: "验证记录", content: [{ id: "entry-evidence", title: "数据校验", description: "参与数据校验。" }] },
  ] };
  const preview = await context("preview_resume_draft_edit", input, true);
  const save = { ...input, previewToken: preview.previewToken, idempotencyKey: "save-resume-draft" };
  await ok("save_resume_draft_edit", save); await connect(); await ok("save_resume_draft_edit", save);
  const web = await import("@/app/api/resumes/[id]/route");
  const result = await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: "1" }) })).json();
  expect(result).toMatchObject({ resume: { title: "修改的草稿" }, modules: preview.value.modules.map((module: Bag) => ({ ...module })) });
  expect(db.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId)).toEqual(beforeVersion);
  expect(db.prepare("SELECT * FROM applications").all()).toEqual(beforeSubmission);
  expect(await ok("get_resume", { id: copy.id })).toMatchObject({ resume: { title: "岗位草稿" }, modules: [{ content: '{"items":["SQLite"]}' }] });
});

it("rejects changed draft previews, competing Web edits and invalid module structures", async () => {
  const basis = await context("get_resume_draft_context", { resumeId: 1 });
  const input = { resumeId: 1, expectedRevision: basis.revision, modules: [{ key: "skills", type: "skills", label: "技能", content: { items: ["事务"] } }] };
  const preview = await context("preview_resume_draft_edit", input, true);
  await fails("save_resume_draft_edit", { ...input, title: "未预览标题", previewToken: preview.previewToken, idempotencyKey: "wrong-draft-preview" }, "CONFLICT");
  await fails("preview_resume_draft_edit", { ...input, modules: [{ key: "skills", type: "summary", label: "技能", content: { text: "修改类型" } }] }, "INVALID_ARGUMENT");
  db.exec("UPDATE resume_modules SET content='{\"items\":[\"网页修改\"]}' WHERE resume_id=1");
  await fails("save_resume_draft_edit", { ...input, previewToken: preview.previewToken, idempotencyKey: "stale-draft-preview" }, "CONFLICT");
  expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历" });
});

it.each(["__proto__", "constructor", "toString"])("lets the Web save modules created through MCP with key %s", async (key) => {
  const input = { resumeId: 1, expectedRevision: (await context("get_resume_draft_context", { resumeId: 1 })).revision,
    modules: [{ key, type: "summary", label: "追加简介", content: { text: "MCP 创建的原文" } }] };
  const preview = await context("preview_resume_draft_edit", input, true);
  await ok("save_resume_draft_edit", { ...input, previewToken: preview.previewToken, idempotencyKey: "special-key-draft" });
  const { PATCH } = await import("@/app/api/resumes/[id]/route"), { loadResume } = await import("@/lib/resumes");
  const { ResumeSaveQueue } = await import("@/lib/resume-save-queue-core");
  const queue = new ResumeSaveQueue(async body => {
    expect(typeof (body.moduleRevisions as Record<string, unknown>)[key]).toBe("string");
    const response = await PATCH(new Request("http://localhost/api/resumes/1", { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    return response.json();
  }, { read: () => "", write: () => {} });
  try {
    await queue.load(async () => loadResume(1)!);
    for (const text of ["网页第一次修改", "网页第二次修改"]) {
      queue.edit({ modules: { [key]: { text } } });
      await queue.flush();
      expect(queue.hasPending).toBe(false);
      expect(loadResume(1)!.modules.find(module => module.key === key)!.content).toMatchObject({ text });
    }
  } finally { queue.disposeAutoWork(); }
});

async function avatarDraftEdit(nextAvatar = "") {
  const storage = await import("@/lib/upload-storage");
  const file = await storage.saveUploadFile(Buffer.from("synthetic avatar"), ".png");
  const content = { ...(await import("@/lib/modules")).defaultContent("basic") as object, avatar: file.url };
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'basic','basic','基本信息',1,?,'')").run(JSON.stringify(content));
  const input = { resumeId: 1, expectedRevision: (await context("get_resume_draft_context", { resumeId: 1 })).revision,
    modules: [{ key: "basic", type: "basic", label: "基本信息", content: { ...content, avatar: nextAvatar } }] };
  const preview = await context("preview_resume_draft_edit", input, true);
  return { storage, file, content, input: { ...input, previewToken: preview.previewToken, idempotencyKey: "avatar-draft-edit" } };
}

it.each(["clear", "replace"])("cleans up an unreferenced avatar after an MCP draft %s", async (operation) => {
  const storage = await import("@/lib/upload-storage");
  const next = operation === "replace" ? await storage.saveUploadFile(Buffer.from("replacement avatar"), ".png") : null;
  const { file, input } = await avatarDraftEdit(next?.url);
  await ok("save_resume_draft_edit", input);
  expect(storage.readUploadFile(file.filename)).toBeNull();
  if (next) expect(storage.readUploadFile(next.filename)).not.toBeNull();
  await connect();
  expect(await ok("save_resume_draft_edit", input)).toEqual({ id: 1 });
});

it.each(["draft", "version"])("preserves an avatar still referenced by another %s", async (reference) => {
  const { storage, file, content, input } = await avatarDraftEdit();
  if (reference === "draft") {
    db.exec("INSERT INTO resumes(id,title,created_at,updated_at) VALUES(2,'共享头像','','')");
    db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(2,'basic','basic','基本信息',0,?,'')").run(JSON.stringify(content));
  } else {
    await (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "带头像版本" });
    // 发布会改变草稿上下文，重新预览后保存。
    input.expectedRevision = (await context("get_resume_draft_context", { resumeId: 1 })).revision;
    input.previewToken = (await context("preview_resume_draft_edit", { resumeId: 1, expectedRevision: input.expectedRevision, modules: input.modules }, true)).previewToken;
  }
  await ok("save_resume_draft_edit", input);
  expect(storage.readUploadFile(file.filename)).not.toBeNull();
  await ok("save_resume_draft_edit", input);
  expect(storage.readUploadFile(file.filename)).not.toBeNull();
});

it("preserves the avatar if the MCP receipt fails and cleans it up only after a successful retry", async () => {
  const { storage, file, content, input } = await avatarDraftEdit();
  db.exec("CREATE TRIGGER fail_avatar_receipt BEFORE INSERT ON mcp_creation_receipts BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  await fails("save_resume_draft_edit", input, "INTERNAL");
  expect(storage.readUploadFile(file.filename)).not.toBeNull();
  expect(JSON.parse((db.prepare("SELECT content FROM resume_modules WHERE resume_id=1 AND module_key='basic'").get() as { content: string }).content)).toEqual(content);
  db.exec("DROP TRIGGER fail_avatar_receipt");
  await ok("save_resume_draft_edit", input);
  expect(storage.readUploadFile(file.filename)).toBeNull();
});

const salaryTurn = { hr_response: "模拟报价仍需审批，请先核对条件。", hr_tactics: "核实条件",
  hr_mindset: { looseness: 20, current_attitude: "待审批", estimated_package: "模拟30k×12", tactics_label: "澄清", internal_pressure: "审批待定" },
  mentor_analysis: { user_argument_score: 7, strengths: ["区分条件"], vulnerabilities: ["条件待确认"], tactical_tips: "核实保证薪数。",
    suggested_replies: [{ title: "澄清", content: "请确认保证薪数。", rationale: "避免混用口径" }] } };
async function careerInput(source: Bag, result: Bag, idempotencyKey: string) {
  return { source, result, idempotencyKey, expectedRevision: (await context("get_career_workflow_context", { source })).revision };
}
async function startSalary() {
  const input = await careerInput({ kind: "salary-create", targetRole: "工程师", expectedSalary: "模拟30k×14" },
    { ...salaryTurn, mentor_analysis: { ...salaryTurn.mentor_analysis, user_argument_score: 5 }, initial_offer: "模拟30k×12，审批待定" }, "salary-create");
  return { input, ...await ok<{ id: number }>("save_career_result", input) };
}

it("saves defense quotes and drills, rejects invented evidence and stale drill results", async () => {
  const source = { kind: "defense", material: { type: "text", content: "参与 SQLite 校验，尚未上线。" }, title: "数据工具排雷" };
  const result = { risk_level: "medium", overall_roast: "需要核对个人职责。", items: [{
    original_text: source.material.content, section_hint: "项目经历", risk_level: "medium", risk_type: "scope_ambiguity",
    interviewer_roast: "请说明个人职责。", deadly_questions: ["你具体负责什么？", "如何核对结果？"],
    defense_plan: { interviewer_intent: "核实职责", standard_defense: "只说明参与校验的事实。", taboo_mistakes: ["编造贡献"] },
  }] };
  const input = await careerInput(source, result, "defense-report");
  await fails("save_career_result", { ...input, result: { ...result, items: [{ ...result.items[0], original_text: "领导全球数据库优化，提升100倍。" }] } }, "INVALID_ARGUMENT");
  const created = await ok<{ id: number }>("save_career_result", input);
  const web = await import("@/app/api/tools/resume-defenses/[id]/route");
  const report = (await (await web.GET(new Request("http://localhost/fixture"), { params: Promise.resolve({ id: String(created.id) }) })).json()).report;
  expect(report.items[0].originalText).toBe(source.material.content);
  const drill = await careerInput({ kind: "defense-drill", defenseId: created.id, itemId: report.items[0].id,
    question: "你具体负责什么？", answer: "我参与校验，尚未上线。" },
  { defense_score: 70, interviewer_roast: "可以再说明方法。", defense_critique: "保留了职责边界。", improved_answer: "我参与 SQLite 校验，尚未上线。" }, "defense-drill");
  await ok("save_career_result", drill); await connect(); await ok("save_career_result", drill);
  await fails("save_career_result", { ...drill, idempotencyKey: "stale-defense-drill" }, "CONFLICT");
  expect((await context("get_career_record", { kind: "resume_defense", id: created.id })).value.related).toHaveLength(1);
});

it("saves gap communication results as the same normalized records read by the Web", async () => {
  const script = { label: "真实表达", applicable_scene: "面试", script: "我有一段空档，希望按真实安排解释。", key_points: ["不添加未提供的经历"] };
  const result = { title: "解释职业空档", punchline: "按已知事实表达。",
    hr_mindset_analysis: { core_concerns: [], risk_points: [], what_hr_wants_to_hear: "具体关注点需要询问确认。" },
    reframe_formula: { fact_acknowledgment: "有一段空档。", positive_attribution: "原因尚待补充。", growth_and_value: "没有提供学习或工作产出。", motivation_alignment: "希望从事后端开发。" },
    scripts: { concise: script, detailed: script, pivoting: script }, drills: [], forbidden_list: ["编造空档经历"], closing_tips: ["补充真实时间和安排。"] };
  const input = await careerInput({ kind: "gap", rawStory: "有一段空档。", targetRole: "后端开发" }, result, "gap-remedy");
  const created = await ok<{ id: number }>("save_career_result", input);
  expect(await ok("save_career_result", input)).toEqual(created);
  const read = await context("get_career_record", { kind: "career_gap_remedy", id: created.id });
  expect(JSON.parse(read.value.record.result)).toMatchObject({ title: result.title, scripts: { concise: { applicableScene: script.applicable_scene } } });
  const web = await import("@/app/api/tools/career-gap-remedies/[id]/route");
  expect((await web.GET(new Request("http://localhost/fixture"), { params: Promise.resolve({ id: String(created.id) }) })).status).toBe(200);
  expect(await ok("list_career_records", { kind: "career_gap_remedy", q: "空档" })).toMatchObject({ items: [{ id: created.id }] });
});

it("reconnects salary workflows, rejects stale turns and invalid report references, then finalizes once", async () => {
  const { id, input } = await startSalary();
  await connect(); expect(await ok("save_career_result", input)).toEqual({ id });
  const turn = await careerInput({ kind: "salary-turn", negotiationId: id, userMessage: "请确认保证薪数。" }, salaryTurn, "salary-turn");
  const saved = await ok("save_career_result", turn); expect(await ok("save_career_result", turn)).toEqual(saved);
  await fails("save_career_result", { ...turn, idempotencyKey: "stale-salary-turn" }, "CONFLICT");
  const report = { final_package_summary: "模拟方案未达成一致。", score: 70, leverage_efficiency: "核实了薪数。", turn_critiques: [
    { turn_no: 2, gain_or_loss: "neutral", summary: "核实条件", key_point: "尚未达成一致" } ], real_world_tips: ["确认书面条件。"], mentor_summary: "结果仍需核实。" };
  const finalize = await careerInput({ kind: "salary-finalize", negotiationId: id }, report, "salary-finalize");
  await fails("save_career_result", { ...finalize, result: { ...report, turn_critiques: [{ ...report.turn_critiques[0], turn_no: 1 }] } }, "INVALID_ARGUMENT");
  await ok("save_career_result", finalize); await connect(); await ok("save_career_result", finalize);
  const read = await context("get_career_record", { kind: "salary_negotiation", id });
  expect(read.value.related).toHaveLength(2); expect(read.value.record.status).toBe("finished");
  expect(JSON.parse(read.value.record.report)).toMatchObject({ ...report, persuasion_grade: "B" });
  const web = await import("@/app/api/tools/salary-negotiations/[id]/route");
  const response = await web.GET(new Request("http://localhost/fixture"), { params: Promise.resolve({ id: String(id) }) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: "finished", turns: [{ turn_no: 1 }, { turn_no: 2 }] });
});

it("rolls back a failed salary opening and rejects source permissions and restored-generation writes", async () => {
  const input = await careerInput({ kind: "salary-create", targetRole: "工程师", expectedSalary: "模拟30k" },
    { ...salaryTurn, mentor_analysis: { ...salaryTurn.mentor_analysis, user_argument_score: 5 }, initial_offer: "模拟25k，待审批。" }, "salary-atomic");
  db.exec("CREATE TRIGGER fail_salary BEFORE INSERT ON salary_negotiation_turns BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await fails("save_career_result", input, "INTERNAL"); expect(db.prepare("SELECT count(*) n FROM salary_negotiations").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_salary");
  db.exec("INSERT INTO runtime_state(id,data_generation) VALUES(1,'restored-career') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation");
  await fails("save_career_result", input, "CONFLICT");
  await connect(new Set(["get_career_workflow_context"]));
  await fails("get_career_workflow_context", { source: { kind: "defense", material: { type: "resume", resumeId: 1, versionId } } }, "FORBIDDEN");
});

it("serializes series advancement and salary turns from independent stdio processes", async () => {
  const source = { kind: "create", resumeId: 1, versionId, jd: "维护数据库", rounds: 1 };
  const { id: seriesId } = await ok<{ id: number }>("save_interview_series_result", { source,
    expectedRevision: (await context("get_interview_series_context", { source })).revision, result: { question: "如何核对数据？" }, idempotencyKey: "series-race-create" });
  const interviewId = (await ok<{ interviews: { id: number }[] }>("get_interview_series", { id: seriesId })).interviews[0]!.id;
  const state = await ok<{ revision: string; currentTurnId: number }>("get_series_interview_state", { seriesId, interviewId });
  await ok("answer_series_interview", { seriesId, interviewId, turnId: state.currentTurnId, expectedRevision: state.revision, answer: "比较数据。",
    evaluation: { depth: 6, structure: 6, authenticity: 6, completeness: 6, comment: "给出了方法。", next_kind: "question", next_question: "" }, idempotencyKey: "series-race-answer" });
  await ok("finish_series_interview", { seriesId, interviewId, expectedRevision: (await ok<{ revision: string }>("get_series_interview_state", { seriesId, interviewId })).revision,
    report: { jd_match: 6, strengths: "表达清楚。", weaknesses: "缺少实例。", suggestions: "说明真实实例。" }, idempotencyKey: "series-race-finish" });
  const advanceSource = { kind: "advance", seriesId, fromInterviewId: interviewId };
  const advance = { source: advanceSource, expectedRevision: (await context("get_interview_series_context", { source: advanceSource })).revision, result: { question: "如何协调数据核对？" } };
  const salary = await startSalary(), turn = await careerInput({ kind: "salary-turn", negotiationId: salary.id, userMessage: "请核对保证薪数。" }, salaryTurn, "salary-race");
  const writers = [0, 1].map(i => new Client({ name: `content-writer-${i}`, version: "1" }));
  try {
    await Promise.all(writers.map(writer => writer.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("scripts/mcp.mjs")], cwd: directory,
      env: { RESUME_LIFE_DATA_DIR: directory, RESUME_LIFE_MCP_WRITE_ENABLED: "true", RESUME_LIFE_MCP_LLM_ENABLED: "false",
        RESUME_LIFE_MCP_ALLOWED_TOOLS: "save_interview_series_result,get_interview_series_context,get_interview_series,get_interview,get_resume,save_career_result,get_career_workflow_context,get_career_record" }, stderr: "ignore" }))));
    for (const [name, args] of [["save_interview_series_result", advance], ["save_career_result", turn]] as const) {
      const results = await Promise.all(writers.map((writer, i) => writer.callTool({ name, arguments: { ...args, idempotencyKey: `race-${name}-${i}` } })));
      expect(results.filter(result => !result.isError)).toHaveLength(1);
      expect(results.find(result => result.isError)?.structuredContent).toMatchObject({ error: { code: "CONFLICT" } });
    }
    expect(db.prepare("SELECT count(*) n FROM interviews WHERE series_id=?").get(seriesId)).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) n FROM salary_negotiation_turns WHERE negotiation_id=?").get(salary.id)).toEqual({ n: 2 });
  } finally { await Promise.all(writers.map(writer => writer.close())); }
}, 30_000);
