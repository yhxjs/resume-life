import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { bindInputs, readAllPages, readContext, uploadBytes, waitForJob } from "../../examples/mcp/helpers.mjs";
import type { Workflow } from "./workflow-catalog-types";

type Bag = Record<string, unknown>;
type Context = { revision: string; previewToken?: string; value: Bag };
let directory: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer, versionId: number, workflows: Workflow[];
async function call(name: string, args: Bag = {}): Promise<Bag> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify({ name, result: result.structuredContent })).not.toBe(true);
  return (result.structuredContent as { data: Bag }).data;
}
const workflow = (id: string) => workflows.find(row => row.id === id)!;
it.each(["resume", "project"])("runs upload and %s import from catalog bindings with minimal permissions", async kind => {
  const bytes = Buffer.from("参与 SQLite 维护，尚未上线。"), vars: Bag = { filename: "facts.txt", purpose: kind, byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), chunkBase64: bytes.toString("base64"), persisted: { uploadKey: "catalog-upload-key" } };
  await connect("file-upload");
  vars.upload = await run("file-upload", 0, vars); vars.offset = await run("file-upload", 1, vars);
  vars.offset = await run("file-upload", 2, vars); await run("file-upload", 3, vars);
  const flow = kind === "resume" ? "file-import" : "project-file-import";
  await connect(flow);
  const target = kind === "resume" ? { kind } : { kind, projectId: 1 };
  const data: Bag = { uploadId: (vars.upload as Bag).uploadId, importSource: { extractionKey: "catalog-extraction", target }, kind,
    persisted: { extractionKey: "catalog-extraction", proposalKey: "catalog-file-proposal", importKey: "catalog-file-save" },
    generatedImport: kind === "resume" ? { title: "目录导入", basic: { name: "示例人物" }, summary: { text: "参与 SQLite 维护，尚未上线。" } } : { title: "目录导入材料" } };
  data.job = await run(flow, 0, data); const job = data.job as Bag;
  const completed = await waitForJob(call, job.jobId as string, { intervalMs: 10 });
  expect(completed.job.status).toBe("succeeded");
  await run(flow, 1, data); await run(flow, 2, data, "context");
  data.basis = await run(flow, 3, data, "context");
  await run(flow, 4, data); data.preview = await run(flow, 5, data, "context");
  const saved = await run(flow, 6, data); expect(await run(flow, 6, data)).toEqual(saved);
});

it("runs template creation/edit and avatar replacement under their exact catalog dependencies", async () => {
  await connect("template-authoring");
  const vars: Bag = { name: "目录模板", templateRef: "classic", editedName: "新模板", style: { accent: "#115599" }, persisted: { createKey: "catalog-template-create", saveKey: "catalog-template-save" } };
  vars.catalog = await run("template-authoring", 0, vars, "context");
  vars.template = await run("template-authoring", 1, vars);
  db.prepare("UPDATE resumes SET template=? WHERE id=1").run("custom:" + (vars.template as Bag).id);
  vars.basis = await run("template-authoring", 2, vars, "context");
  vars.preview = await run("template-authoring", 3, vars, "preview");
  await run("template-authoring", 4, vars);
  const sharp = (await import("sharp")).default, bytes = await sharp({ create: { width: 32, height: 40, channels: 3, background: "#115599" } }).png().toBuffer();
  await connect("file-upload");
  const uploaded = await uploadBytes(call, { bytes, filename: "photo.png", purpose: "avatar", idempotencyKey: "catalog-avatar-upload" });
  const { normalizeContent } = await import("@/lib/modules");
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'basic','basic','基本信息',1,?,'')")
    .run(JSON.stringify(normalizeContent("basic", { name: "示例人物" })));
  await connect("avatar-update");
  const avatar: Bag = { resumeId: 1, moduleKey: "basic", uploadId: uploaded.uploadId, persisted: { avatarKey: "catalog-avatar-set" } };
  avatar.basis = await run("avatar-update", 0, avatar, "context"); await run("avatar-update", 1, avatar);
  const saved = await run("avatar-update", 2, avatar); expect(JSON.stringify(saved)).toContain("/api/uploads/");
});

it("runs incremental repository changes from catalog bindings with only declared permissions", async () => {
  const root = path.join(directory, "repository"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"catalog"}');
  fs.writeFileSync(path.join(root, "main.ts"), "export const value = 1;");
  vi.stubEnv("RESUME_LIFE_MCP_REPO_ROOTS", JSON.stringify([root]));
  await call("capture_project_repository", { projectId: 1, repositoryIndex: 0, idempotencyKey: "catalog-base-capture",
    expectedCatalogRevision: (await readContext(call, "get_repository_catalog")).revision,
    expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId: 1 })).revision });
  const base = await readContext(call, "get_repository_capture", { idempotencyKey: "catalog-base-capture" });
  await call("save_repository_evidence", { projectId: 1, captureKey: "catalog-base-capture", fileIndexes: base.value.files.map((file: { index: number }) => file.index),
    expectedCaptureRevision: base.revision, expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId: 1 })).revision, idempotencyKey: "catalog-base-save" });
  fs.writeFileSync(path.join(root, "main.ts"), "export const value = 2;");
  const id = "repository-incremental"; await connect(id);
  const vars: Bag = { projectId: 1, repositoryIndex: 0, baseCaptureKey: "catalog-base-capture",
    selections: [{ locator: "repository/main.ts", action: "upsert" }], persisted: { nextCaptureKey: "catalog-next-capture", updateKey: "catalog-update-evidence" } };
  vars.catalog = await run(id, 0, vars, "context"); vars.project = await run(id, 1, vars, "context");
  await run(id, 2, vars); vars.basis = await run(id, 3, vars, "context");
  vars.preview = await run(id, 4, vars, "preview"); await run(id, 5, vars);
  const history = await run<Bag[]>(id, 6, vars, "list");
  expect(history.some(row => row.change_kind === "modified")).toBe(true);
});

it("runs filtered search and cache cleanup under minimal catalog permissions", async () => {
  db.exec("INSERT INTO applications(company,role,stage,created_at,updated_at) VALUES('示例公司','SQLite 开发','applied','','')");
  await connect("filtered-search");
  expect(await run("filtered-search", 0, { query: "SQLite", stages: ["applied"] }, "list")).toMatchObject([{ domain: "application" }]);
  await connect("cache-maintenance");
  const preview = await run("cache-maintenance", 0, {});
  expect(await run("cache-maintenance", 1, { preview })).toMatchObject({ removedEntries: 0 });
});
async function connect(id?: string) {
  await client?.close(); await server?.close();
  const selected = id ? workflow(id) : undefined;
  const allowlist = selected ? new Set([...selected.dependencies, ...selected.steps.map(step => step.tool)]) : null;
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist, writeEnabled: true, llmEnabled: false, timeoutMs: 10_000 });
  client = new Client({ name: "catalog-workflow-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
async function run<T = Bag>(id: string, index: number, variables: Bag, mode: "call" | "context" | "preview" | "list" = "call"): Promise<T> {
  const step = workflow(id).steps[index]!, args = bindInputs(step.inputs, variables) as Bag;
  return (mode === "call" ? await call(step.tool, args) : mode === "list" ? await readAllPages(call, step.tool, args)
    : await readContext(call, step.tool, args, mode === "preview")) as T;
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-catalog-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory); db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes(id,title,created_at,updated_at) VALUES(1,'资料','',''); INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'本地数据库','',''); INSERT INTO project_materials(project_id,title,content,created_at) VALUES(1,'事实','参与维护本地数据库，使用 SQLite。','')");
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'summary','summary','自我评价',0,?,'')").run(JSON.stringify({ text: "参与维护本地 SQLite 数据库。" }));
  versionId = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "固定版" }).id;
  workflows = (await import("./workflow-catalog")).MCP_WORKFLOWS;
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-catalog-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

it("binds every required argument in the registered input contracts and names only real capabilities", async () => {
  const tools = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));
  for (const flow of workflows) {
    for (const name of flow.dependencies) expect(tools.has(name), flow.id + ":" + name).toBe(true);
    for (const step of flow.steps) {
      const tool = tools.get(step.tool)!; expect(tool, flow.id + ":" + step.tool).toBeDefined();
      const schema = tool.inputSchema;
      for (const required of schema.required ?? []) expect(Object.hasOwn(step.inputs, required), flow.id + ":" + step.tool + ":" + required).toBe(true);
      for (const bound of Object.keys(step.inputs)) expect(Object.hasOwn(schema.properties ?? {}, bound), flow.id + ":" + step.tool + ":" + bound).toBe(true);
    }
  }
});

it.each(["application", "resume"])("executes %s three-way conflict resolution through the production registrar and exact catalog permissions", async kind => {
  const app = await call("create_application", { company: "并发公司", role: "开发", stage: "interested", idempotencyKey: "rebase-catalog-app" });
  const id = kind + "-conflict-resolution";
  await connect(id);
  const vars: Bag = { applicationId: app.id, resumeId: 1, proposed: kind === "application" ? { notes: "Agent 备注" } : { title: "Agent 标题", modules: [] }, persisted: { saveKey: "catalog-rebase-save" } };
  vars.basis = kind === "application" ? await run(id, 0, vars) : await run(id, 0, vars, "context");
  vars.base = (await run<Context>(id, 1, vars, "preview")).value;
  if (kind === "application") db.prepare("UPDATE applications SET notes='网页备注',jd='网页保留 JD' WHERE id=?").run(Number(app.id));
  else db.exec("UPDATE resumes SET title='网页标题' WHERE id=1");
  vars.comparison = (await run<Context>(id, 2, vars, "preview")).value;
  expect(vars.comparison).toMatchObject({ unresolved: 1, prepared: null });
  vars.choices = [{ path: [kind === "application" ? "notes" : "title"], take: "proposed" }];
  vars.resolved = (await run<Context>(id, 3, vars, "preview")).value;
  expect(vars.resolved).toMatchObject({ unresolved: 0 });
  vars.preview = await run<Context>(id, 4, vars, "preview");
  const saved = await run(id, 5, vars);
  expect(await run(id, 5, vars)).toEqual(saved);
  if (kind === "application") expect(db.prepare("SELECT notes,jd FROM applications WHERE id=?").get(Number(app.id))).toEqual({ notes: "Agent 备注", jd: "网页保留 JD" });
  else {
    expect(db.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "Agent 标题" });
    expect(db.prepare("SELECT json_extract(snapshot,'$.title') title FROM resume_versions WHERE id=?").get(versionId)).toEqual({ title: "资料" });
  }
});

it("runs intro creation from catalog bindings using only declared permissions", async () => {
  const id = "intro-generation"; await connect(id);
  const vars: Bag = { resumeId: 1, versionId, jd: "维护本地数据库", generatedIntro: { versions: ["30s", "2min"].map(kind => ({
    kind, sentences: [{ text: "我参与维护本地数据库，希望从事相关工作。", comment: "分别表达事实和意向。" }],
  })) }, persisted: { introKey: "catalog-intro-create" } };
  vars.basis = await run(id, 0, vars, "context"); vars.intro = await run(id, 1, vars);
  expect(await run(id, 1, vars)).toEqual(vars.intro);
  await run(id, 2, vars); const saved = await run<Context>(id, 3, vars, "context");
  expect(JSON.stringify(saved.value)).toContain("参与维护本地数据库");
});

it("previews and saves the identical project summary proposal under its minimum permissions", async () => {
  const id = "project-summary"; await connect(id);
  const vars: Bag = { projectId: 1, generatedSummary: { overview: "本地数据库维护", architecture: "使用 SQLite", highlights: "", responsibilities: "参与维护", challenges: "",
    techStack: "SQLite", brief: "本地数据库维护", achievements: ["参与本地数据库维护。"] }, acceptedKeys: [], persisted: { summaryKey: "catalog-project-summary" } };
  vars.basis = await run(id, 0, vars, "context");
  const preview = await run<Context>(id, 1, vars, "preview");
  vars.acceptedKeys = (preview.value.comparison as { key: string }[]).map(change => change.key);
  vars.preview = await run(id, 1, vars, "preview"); vars.history = await run(id, 2, vars);
  expect(await run(id, 2, vars)).toEqual(vars.history);
  expect(await run<Bag[]>(id, 3, vars, "list")).toHaveLength(1);
  expect(db.prepare("SELECT summary FROM projects WHERE id=1").get()?.summary).toContain("SQLite");
});

it("generates, answers and reads full practice context with only the workflow's capabilities", async () => {
  const id = "practice-generation"; await connect(id);
  const vars: Bag = { direction: "后端", jd: "维护数据库", questionCount: 1, generatedQuestions: { questions: [{ kind: "tech", question: "如何验证事务原子性？" }] },
    answer: "检查事务提交前后的完整记录。", evaluation: { depth: 8, structure: 7, authenticity: 9, completeness: 7, comment: "说明了验证对象。", reference: "按实际操作核对事务前后记录。" },
    persisted: { practiceKey: "catalog-practice-create", answerKey: "catalog-practice-answer" } };
  vars.basis = await run(id, 0, vars, "context"); vars.session = await run(id, 1, vars);
  vars.questionId = (await run<Bag[]>(id, 2, vars, "list"))[0]!.id;
  vars.answerBasis = await run(id, 3, vars); await run(id, 4, vars, "context"); await run(id, 5, vars);
  expect(db.prepare("SELECT answer FROM drill_questions WHERE id=?").get(Number(vars.questionId))?.answer).toBe(vars.answer);
});

it("reviews a due card exactly once and recovers the submission with the catalog permissions", async () => {
  const { createSelectedPractice } = await import("@/lib/mcp-practice");
  const bankId = Number(db.prepare("INSERT INTO bank_entries(direction,kind,question,created_at) VALUES('后端','tech','如何检查事务？','')").run().lastInsertRowid);
  const bank = await call("list_bank_entries");
  const entry = (bank.items as { id: number; revision: string }[]).find(row => row.id === bankId)!;
  const session = createSelectedPractice({ entries: [entry], jd: "", idempotencyKey: "review-fixture-session" });
  const question = (await call("list_practice_questions", { drillId: session.id })).items as { id: number }[];
  const favorite = await call("bookmark_practice_question", { source: "drill", sourceId: question[0]!.id, idempotencyKey: "review-fixture-bookmark" });
  const cardId = (db.prepare("SELECT id FROM review_cards WHERE notebook_id=?").get(Number(favorite.id)) as { id: number }).id;
  const id = "review-practice"; await connect(id);
  const vars: Bag = { cardId, timeZone: "Asia/Hong_Kong", answer: "先确认完整的事务边界。", grade: "good", persisted: { requestId: randomUUID() } };
  expect(await run<Bag[]>(id, 0, vars, "list")).toHaveLength(1);
  vars.card = await run(id, 1, vars); await run(id, 2, vars, "context"); const saved = await run(id, 3, vars);
  expect(await run(id, 3, vars)).toEqual(saved); const submission = await run(id, 4, vars);
  expect(submission.card).toMatchObject({ review_count: 1 });
});

it("runs all three series rounds and finalization while reconnecting with each step group's minimum permissions", async () => {
  const vars: Bag = { resumeId: 1, versionId, jd: "维护数据库", rounds: 1, firstQuestion: "如何核对事务？", persisted: { seriesKey: "catalog-series-create" } };
  await connect("series-create"); vars.basis = await run("series-create", 0, vars, "context"); vars.series = await run("series-create", 1, vars);
  const series = await run("series-create", 2, vars); await run("series-create", 3, vars, "context");
  vars.seriesId = (vars.series as Bag).id; vars.interviewId = (series.interviews as { id: number }[])[0]!.id;
  vars.answer = "根据实际情况核对职责和验证方式。";
  vars.evaluation = { depth: 8, structure: 7, authenticity: 9, completeness: 7, comment: "明确了边界。", next_kind: "question", next_question: "" };
  vars.report = { jd_match: 7, strengths: "表达明确。", weaknesses: "需要具体实例。", suggestions: "补充真实实例。" };
  for (let round = 1; round <= 3; round++) {
    await connect("series-round"); vars.persisted = { answerKey: "catalog-round-" + round, reportKey: "catalog-report-" + round };
    vars.state = await run("series-round", 0, vars); await run("series-round", 1, vars, "context"); await run("series-round", 2, vars);
    vars.afterAnswer = await run("series-round", 3, vars); await run("series-round", 4, vars);
    if (round < 3) {
      await connect("series-advance"); vars.firstQuestion = round === 1 ? "如何安排团队协作？" : "期待怎样的团队？"; vars.persisted = { advanceKey: "catalog-advance-" + round };
      vars.basis = await run("series-advance", 0, vars, "context"); vars.interviewId = (await run("series-advance", 1, vars)).id;
    }
  }
  await connect("series-finalize"); vars.basis = await run("series-finalize", 0, vars, "context");
  vars.generatedReport = { verdict: "具备基本表达能力。", strengths: "表达明确。", weaknesses: "需要具体实例。", suggestions: "补充真实实例。" }; vars.persisted = { finalizeKey: "catalog-series-finalize" };
  await run("series-finalize", 1, vars);
  expect(db.prepare("SELECT final_report FROM interview_series WHERE id=?").get(Number(vars.seriesId))?.final_report).toContain("具备基本表达能力");
});

it("completes salary simulation opening, turn and report under the catalog's minimum capabilities", async () => {
  const id = "salary-training"; await connect(id);
  const turn = { hr_response: "模拟报价尚需审批，请核对保证薪数。", hr_tactics: "澄清条件",
    hr_mindset: { looseness: 20, current_attitude: "待审批", estimated_package: "模拟30k×12", tactics_label: "澄清", internal_pressure: "审批待定" },
    mentor_analysis: { user_argument_score: 7, strengths: ["区分条件"], vulnerabilities: ["条件待确认"], tactical_tips: "核实保证薪数。",
      suggested_replies: [{ title: "澄清", content: "请确认保证薪数。", rationale: "避免混用口径" }] } };
  const vars: Bag = { createSource: { kind: "salary-create", targetRole: "工程师", expectedSalary: "模拟30k×14" },
    openingResult: { ...turn, initial_offer: "模拟30k×12，待审批", mentor_analysis: { ...turn.mentor_analysis, user_argument_score: 5 } },
    userMessage: "请核对保证薪数。", turnResult: turn, finalWords: "条件尚待确认。", agreedPackage: "模拟30k×12，待审批",
    finalResult: { final_package_summary: "模拟条件待核实。", score: 70, leverage_efficiency: "仍需核对。",
      turn_critiques: [{ turn_no: 2, gain_or_loss: "neutral", summary: "询问保证薪数。", key_point: "口径需核对。" }],
      real_world_tips: ["核实书面条件。"], mentor_summary: "模拟练习完成。" },
    persisted: { salaryKey: "catalog-salary-start", turnKey: "catalog-salary-turn", finalizeKey: "catalog-salary-final" } };
  vars.openingBasis = await run(id, 0, vars, "context"); vars.negotiation = await run(id, 1, vars);
  vars.turnBasis = await run(id, 2, vars, "context"); await run(id, 3, vars);
  vars.finalBasis = await run(id, 4, vars, "context"); await run(id, 5, vars);
  const saved = await run<Context>(id, 6, vars, "context"); expect(JSON.stringify(saved.value)).toContain("模拟练习完成");
});
