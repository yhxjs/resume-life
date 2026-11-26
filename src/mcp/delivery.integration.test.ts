import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";

let directory: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer, versionId: number, diagnosisId: number;
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
  client = new Client({ name: "delivery", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-delivery-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory); db = (await import("@/lib/db")).getDb();
  db.exec(`INSERT INTO resumes(id,title,created_at,updated_at) VALUES(1,'固定履历','','');
    INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES
    (1,'skills','skills','技能',1,'{"items":["SQLite"]}',''),
    (1,'summary','summary','自我评价',2,'{"text":"参与数据工具开发。"}',''),
    (1,'basic','basic','基本信息',0,'{"name":"王小明","phone":"13800138000","email":"xiaoming@example.com","location":"香港","birthday":"","links":""}','');
    INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'数据工具','','');
    INSERT INTO project_materials(id,project_id,title,content,created_at) VALUES(1,1,'事实材料','参与 SQLite 校验。','');`);
  const { normalizeContent, isModuleKey } = await import("@/lib/modules");
  for (const row of db.prepare("SELECT id,type,content FROM resume_modules").all() as { id: number; type: string; content: string }[]) {
    if (isModuleKey(row.type)) db.prepare("UPDATE resume_modules SET content=? WHERE id=?").run(JSON.stringify(normalizeContent(row.type, JSON.parse(row.content))), row.id);
  }
  versionId = (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "原版" }).id;
  const loaded = (await import("@/lib/resumes")).loadResume(1)!;
  diagnosisId = Number(db.prepare(`INSERT INTO resume_diagnoses(resume_id,resume_version_id,job_id,job_title,jd,report,resume_snapshot,created_at)
    VALUES(1,?,'job','后端','SQLite 开发',?,?, '')`).run(versionId, JSON.stringify({ match: 7, summary: "补充技能程度。", modules: [{ moduleKey: "skills", label: "技能",
      scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [{ itemId: "", field: "items", reason: "明确经验范围", draft: ["接触过 SQLite"] }] }] }),
    JSON.stringify({ title: loaded.resume.title, modules: loaded.modules.map(({ key, type, label, sort, content }) => ({ key, type, label, sort, content })) })).lastInsertRowid);
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-delivery-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
async function adoptionInput() {
  const source = { resumeId: 1, diagnosisId };
  const proposal = { ...source, expectedRevision: (await context("get_diagnosis_adoption_context", source)).revision, selections: [{ moduleKey: "skills", suggestionIndex: 0 }] };
  return { ...proposal, previewToken: (await context("preview_diagnosis_adoption", proposal, true)).previewToken, idempotencyKey: "adopt-diagnosis-one" };
}
async function artifactBytes(artifactId: string) {
  const parts: Buffer[] = []; let offset = 0;
  while (true) {
    const page = await ok<{ data: string; nextOffset: number | null; sha256: string }>("read_export_artifact", { artifactId, offset, length: 1021 });
    parts.push(Buffer.from(page.data, "base64"));
    if (page.nextOffset === null) {
      const bytes = Buffer.concat(parts); expect(createHash("sha256").update(bytes).digest("hex")).toBe(page.sha256); return bytes;
    }
    offset = page.nextOffset;
  }
}

it("adopts atomically, publishes once, exports and binds the exact published snapshot to an application", async () => {
  const adoption = await adoptionInput(); await ok("save_diagnosis_adoption", adoption);
  const web = await import("@/app/api/resumes/[id]/diagnose/route");
  expect(await (await web.GET(new Request(`http://localhost/api/resumes/1/diagnose?diagnosis_id=${diagnosisId}`), { params: Promise.resolve({ id: "1" }) })).json())
    .toMatchObject({ adoptions: [{ moduleKey: "skills", value: ["接触过 SQLite"] }] });
  const publication = { resumeId: 1, expectedRevision: (await context("get_resume_version_context", { resumeId: 1 })).revision, name: "岗位版", idempotencyKey: "publish-delivery-one" };
  const published = await ok<{ id: number }>("publish_resume_version", publication);
  await connect(); expect(await ok("save_diagnosis_adoption", adoption)).toEqual({ id: diagnosisId });
  expect(await ok("publish_resume_version", publication)).toEqual(published);
  const source = { resumeId: 1, versionId: published.id };
  const request = { source, expectedRevision: (await context("get_resume_export_context", { source })).revision, format: "markdown", idempotencyKey: "export-delivery-one" };
  const artifact = await ok<{ artifactId: string }>("export_resume", request);
  db.exec("UPDATE resume_modules SET content='{\"items\":[\"新的草稿\"]}' WHERE module_key='skills'");
  expect((await artifactBytes(artifact.artifactId)).toString()).toContain("接触过 SQLite");
  await connect(); expect(await ok("export_resume", request)).toMatchObject(artifact);
  const application = await ok<{ id: number }>("create_application", { company: "示例公司", role: "后端", stage: "applied", resume_id: 1, resume_version_id: published.id, idempotencyKey: "delivery-application" });
  expect(db.prepare("SELECT resume_version_id FROM applications WHERE id=?").get(application.id)).toEqual({ resume_version_id: published.id });
  expect(db.prepare("SELECT count(*) n FROM resume_versions").get()).toEqual({ n: 2 });
});

it("rolls back the draft and receipt when adoption storage fails, then accepts the same key", async () => {
  const input = await adoptionInput();
  db.exec("CREATE TRIGGER fail_adoption BEFORE UPDATE OF adoptions ON resume_diagnoses BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  await fails("save_diagnosis_adoption", input, "INTERNAL");
  expect(db.prepare("SELECT content FROM resume_modules WHERE module_key='skills'").get()).toEqual({ content: '{"items":["SQLite"]}' });
  expect(db.prepare("SELECT count(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_adoption"); await ok("save_diagnosis_adoption", input);
});

it("rejects stale, altered and duplicate adoption targets without writes", async () => {
  const input = await adoptionInput();
  await fails("save_diagnosis_adoption", { ...input, selections: [{ moduleKey: "skills", suggestionIndex: 0, value: ["不同内容"] }] }, "CONFLICT");
  await fails("preview_diagnosis_adoption", { resumeId: 1, diagnosisId, expectedRevision: input.expectedRevision, selections: [input.selections[0], input.selections[0]] }, "INVALID_ARGUMENT");
  db.exec("UPDATE resume_modules SET content='{\"items\":[\"发生并发修改\"]}' WHERE module_key='skills'");
  await fails("save_diagnosis_adoption", input, "CONFLICT");
  expect(db.prepare("SELECT adoptions FROM resume_diagnoses").get()).toEqual({ adoptions: "[]" });
});

it.each((["work", "projects", "education", "summary"] as const).flatMap(type =>
  (["textFormat", "draftFormat", "legacy", "edited"] as const).map(format => ({ type, format }))))(
  "preserves $format suggestions through $type adoption preview, storage and history", async ({ type, format }) => {
    const { normalizeContent } = await import("@/lib/modules");
    const { loadResume } = await import("@/lib/resumes");
    const { diagnosisValue } = await import("@/lib/diagnosis");
    const { stripRichText } = await import("@/lib/rich-text");
    const literal = "使用 Array<T>、<template> 和 &amp;。\r\n保留 <strong>字面</strong>。";
    const rich = "<strong>维护数据工具</strong><br>使用 Array&lt;T&gt;。";
    const content = normalizeContent(type, type === "summary" ? { text: "原始正文。" } : [{ id: "entry", description: "原始正文。" }]);
    db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'target',?,'测试正文',3,?,'')")
      .run(type, JSON.stringify(content));
    const suggestion = { itemId: type === "summary" ? "" : "entry", field: type === "summary" ? "text" as const : "description" as const,
      reason: "保留字面内容", draft: format === "legacy" ? rich : literal };
    const loaded = loadResume(1)!;
    db.prepare("UPDATE resume_diagnoses SET report=?,resume_snapshot=? WHERE id=?").run(JSON.stringify({
      ...(format === "legacy" ? {} : { [format === "draftFormat" ? "draftFormat" : "textFormat"]: "plain-text" }),
      match: 7, summary: "核对正文", modules: [{ moduleKey: "target", label: "测试正文",
        scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [suggestion] }],
    }), JSON.stringify({ title: loaded.resume.title, modules: loaded.modules.map(({ key, type, label, sort, content }) => ({ key, type, label, sort, content })) }), diagnosisId);
    const source = { resumeId: 1, diagnosisId };
    const proposal = { ...source, expectedRevision: (await context("get_diagnosis_adoption_context", source)).revision,
      selections: [{ moduleKey: "target", suggestionIndex: 0, ...(format === "edited" ? { value: rich } : {}) }] };
    const preview = await context("preview_diagnosis_adoption", proposal, true);
    const expectedText = format === "legacy" || format === "edited" ? "维护数据工具\n使用 Array<T>。" : literal.replace(/\r\n/g, "\n");
    expect(stripRichText(preview.value.selections[0].after)).toBe(expectedText);
    await ok("save_diagnosis_adoption", { ...proposal, previewToken: preview.previewToken, idempotencyKey: "literal-adoption" });
    const saved = diagnosisValue(loadResume(1)!.modules, "target", suggestion);
    expect(saved).toBe(preview.value.selections[0].after);
    expect(stripRichText(saved as string)).toBe(expectedText);
    if (format === "legacy" || format === "edited") expect(saved).toContain("<strong>维护数据工具</strong>");
    const history = (await import("@/lib/diagnosis-history")).loadDiagnosis(1, diagnosisId)!;
    expect(history.adoptions).toMatchObject([{ moduleKey: "target", suggestionIndex: 0, value: saved }]);
  });

it("previews module removal, complete ordering and style changes and keeps old publication frozen", async () => {
  const proposal = { resumeId: 1, expectedRevision: (await context("get_resume_layout_context", { resumeId: 1 })).revision,
    removeKeys: ["summary"], moduleOrder: ["skills", "basic"], template: "classic", styleOverrides: { accent: "#112233", baseSize: 15 } };
  const preview = await context("preview_resume_layout", proposal, true);
  await ok("save_resume_layout", { ...proposal, previewToken: preview.previewToken, idempotencyKey: "layout-delivery-one" });
  const web = await import("@/app/api/resumes/[id]/route");
  const current = await (await web.GET(new Request("http://localhost/api/resumes/1"), { params: Promise.resolve({ id: "1" }) })).json();
  expect(current.modules.map((m: { key: string }) => m.key)).toEqual(["skills", "basic"]);
  expect(preview.value.after.styleOverrides).toEqual({ accent: "#112233", baseSize: 14 });
  expect(current.resume.style_overrides).toEqual(preview.value.after.styleOverrides);
  const old = (await import("@/lib/resume-versions")).getResumeVersion(1, versionId)!;
  expect(old.snapshot.modules).toHaveLength(3); expect(old.snapshot.style_overrides).toEqual({});
  const comparison = await context("compare_resume_versions", { resumeId: 1, beforeVersionId: versionId }, true);
  expect(comparison.value.changes.modules.some((m: { key: string; after: unknown }) => m.key === "summary" && m.after === null)).toBe(true);
});

it("branches only an unchanged preview and preserves history through replay", async () => {
  db.exec("UPDATE resumes SET title='正在编辑' WHERE id=1");
  const source = { resumeId: 1, versionId };
  const proposal = { ...source, expectedRevision: (await context("get_resume_version_context", source)).revision };
  const preview = await context("preview_resume_version_branch", proposal, true);
  const request = { ...proposal, previewToken: preview.previewToken, idempotencyKey: "branch-delivery-one" };
  expect(preview.value.changes.title).toEqual({ before: "正在编辑", after: "固定履历" });
  await ok("branch_resume_version", request); await connect(); await ok("branch_resume_version", request);
  expect(db.prepare("SELECT title,base_version_id FROM resumes WHERE id=1").get()).toEqual({ title: "固定履历", base_version_id: versionId });
  expect(db.prepare("SELECT count(*) n FROM resume_versions").get()).toEqual({ n: 1 });
});

it("compares actual content without treating draft revision metadata as a module change", async () => {
  const input = { resumeId: 1, beforeVersionId: versionId };
  expect((await context("compare_resume_versions", input, true)).value.changes.modules).toEqual([]);
  db.exec("UPDATE resume_modules SET content='{\"items\":[\"变更技能\"]}' WHERE module_key='skills'");
  expect((await context("compare_resume_versions", input, true)).value.changes.modules.map((entry: { key: string }) => entry.key)).toEqual(["skills"]);
});

it.each(["docx", "pdf"])("exports real %s bytes with frozen style and anonymization", async format => {
  const anonymizeConfig = (await import("@/lib/resume-anonymize")).DEFAULT_ANONYMIZE_CONFIG;
  const source = { resumeId: 1, versionId, anonymizeConfig };
  const preview = await context("get_resume_export_context", { source });
  const artifact = await ok<{ artifactId: string; byteLength: number }>("export_resume", { source, expectedRevision: preview.revision, format, idempotencyKey: `export-real-${format}` });
  const bytes = await artifactBytes(artifact.artifactId); expect(bytes.length).toBe(artifact.byteLength);
  if (format === "pdf") expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  else {
    const zip = await JSZip.loadAsync(bytes), xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).not.toContain("13800138000"); expect(xml).not.toContain("王小明"); expect(xml).toContain("SQLite");
  }
}, 60_000);

it("invalidates export previews on source edits and artifact reads on backup generation changes", async () => {
  const source = { resumeId: 1 }, expectedRevision = (await context("get_resume_export_context", { source })).revision;
  const request = { source, expectedRevision, format: "markdown", idempotencyKey: "export-generation-one" };
  db.exec("UPDATE resumes SET title='变更标题' WHERE id=1"); await fails("export_resume", request, "CONFLICT");
  request.expectedRevision = (await context("get_resume_export_context", { source })).revision;
  const artifact = await ok<{ artifactId: string }>("export_resume", request);
  await artifactBytes(artifact.artifactId);
  db.exec("INSERT INTO runtime_state(id,data_generation) VALUES(1,'restored-fixture') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation");
  await fails("read_export_artifact", { artifactId: artifact.artifactId }, "CONFLICT");
  await fails("export_resume", request, "CONFLICT");
});

it.each(["title", "label", "rich-text", "entry"])("bounds chained anonymization in readonly export context: %s", async surface => {
  const anonymizeConfig = structuredClone((await import("@/lib/resume-anonymize")).DEFAULT_ANONYMIZE_CONFIG);
  anonymizeConfig.name.enabled = false;
  anonymizeConfig.customRules = Array.from({ length: 18 }, (_, i) => ({ id: String(i), source: "Q", replacement: "QQ" }));
  if (surface === "title") db.exec("UPDATE resumes SET title='Q' WHERE id=1");
  if (surface === "label") db.exec("UPDATE resume_modules SET label='Q' WHERE module_key='skills'");
  if (surface === "rich-text") db.prepare("UPDATE resume_modules SET content=? WHERE module_key='summary'").run(JSON.stringify({ text: "<strong>Q</strong>" }));
  if (surface === "entry") db.prepare("UPDATE resume_modules SET type='work',content=? WHERE module_key='summary'").run(JSON.stringify([{ id: "entry", company: "Q" }]));
  await connect(null, false);
  await fails("get_resume_export_context", { source: { resumeId: 1, anonymizeConfig } }, "INVALID_ARGUMENT");
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
  expect(await ok("get_mcp_status")).toBeDefined();
});

it.each(["custom-rule", "name-placeholder"])("counts UTF-8 expansion before allocating export text: %s", async mode => {
  const anonymizeConfig = structuredClone((await import("@/lib/resume-anonymize")).DEFAULT_ANONYMIZE_CONFIG);
  db.prepare("UPDATE resumes SET title=? WHERE id=1").run("Q".repeat(25_000));
  db.prepare("UPDATE resume_modules SET content=? WHERE module_key='basic'").run(JSON.stringify({ name: "Q" }));
  anonymizeConfig.name = { enabled: mode === "name-placeholder", mode: "placeholder", customPlaceholder: "字".repeat(200) };
  anonymizeConfig.customRules = mode === "custom-rule" ? [{ id: "expand", source: "Q", replacement: "字".repeat(2000) }] : [];
  await connect(null, false);
  await fails("get_resume_export_context", { source: { resumeId: 1, anonymizeConfig } }, "INVALID_ARGUMENT");
});

it("pages and exports unchanged legacy backup entries with empty IDs without rewriting them", async () => {
  const { normalizeContent } = await import("@/lib/modules");
  const legacy = normalizeContent("work", [{ company: "历史公司", title: "工程师", description: "维护应用", subItems: [{ label: "职责", value: "开发" }] }]);
  legacy[0]!.id = ""; legacy[0]!.subItems![0]!.id = "";
  const raw = JSON.stringify(legacy);
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'work','work','工作',3,?,'')").run(raw);
  const { createBackupRecordStream } = await import("@/lib/backup-records");
  const { stageBackupRecordStream } = await import("@/lib/backup-staging");
  const { restoreAllData } = await import("@/lib/backup");
  const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  try { restoreAllData(staged, true); } finally { staged.dispose(); }
  const source = { resumeId: 1 };
  const first = await context("get_resume_export_context", { source });
  await connect();
  const second = await context("get_resume_export_context", { source });
  expect(second).toEqual(first);
  expect(db.prepare("SELECT content FROM resume_modules WHERE module_key='work'").get()).toEqual({ content: raw });
  const request = { source, expectedRevision: first.revision, format: "markdown", idempotencyKey: "legacy-backup-export" };
  const artifact = await ok<{ artifactId: string }>("export_resume", request);
  expect((await artifactBytes(artifact.artifactId)).toString()).toContain("历史公司");
  db.prepare("UPDATE resume_modules SET content=? WHERE module_key='work'").run(raw.replace("历史公司", "修改后的公司"));
  await fails("export_resume", { ...request, idempotencyKey: "legacy-edited-export" }, "CONFLICT");
});

it("requires source read permissions and keeps all new writes disabled in readonly mode", async () => {
  const adoption = await adoptionInput();
  await connect(new Set(["get_diagnosis_adoption_context"]));
  await fails("get_diagnosis_adoption_context", { resumeId: 1, diagnosisId }, "FORBIDDEN");
  await connect(null, false); await fails("save_diagnosis_adoption", adoption, "FORBIDDEN");
  await fails("export_resume", { source: { resumeId: 1 }, expectedRevision: "a".repeat(64), format: "markdown", idempotencyKey: "forbidden-export" }, "FORBIDDEN");
});

it("persists per-line import results across reconnect and rejects duplicate or stale imports", async () => {
  db.exec("INSERT INTO bank_entries(direction,kind,question,created_at) VALUES('后端','tech','SQLite 如何保证原子性？','')");
  const proposal = { direction: "后端", kind: "tech", text: "SQLite 如何保证原子性？\n如何设计重试？\n如何设计重试？" };
  const preview = await context("preview_bank_import", proposal, true);
  expect(preview.value.items.map((item: { action: string }) => item.action)).toEqual(["existing", "insert", "duplicate"]);
  const request = { ...proposal, previewToken: preview.previewToken, idempotencyKey: "bank-import-delivery" };
  const saved = await ok("save_bank_import", request); expect(saved).toMatchObject({ createdCount: 1, skippedCount: 2 });
  const result = await context("get_bank_import_result", { idempotencyKey: request.idempotencyKey });
  expect(result.value.items[1].id).toBe(result.value.items[2].id);
  await connect(); expect(await ok("save_bank_import", request)).toEqual(saved);
  expect((await context("get_bank_import_result", { idempotencyKey: request.idempotencyKey })).value).toEqual(result.value);
  expect(db.prepare("SELECT count(*) n FROM bank_entries").get()).toEqual({ n: 2 });
  await fails("save_bank_import", { ...request, text: "不同的问题？" }, "CONFLICT");
  const second = { ...proposal, text: "新的题目？" }, before = await context("preview_bank_import", second, true);
  db.exec("INSERT INTO bank_entries(direction,kind,question,created_at) VALUES('后端','tech','新的题目？','')");
  await fails("save_bank_import", { ...second, previewToken: before.previewToken, idempotencyKey: "stale-bank-import" }, "CONFLICT");
});

it("atomically rolls back a batch and its result, and pages 500 imported IDs losslessly", async () => {
  const proposal = { direction: "后端", kind: "tech", text: "问题一？\n问题二？" };
  const preview = await context("preview_bank_import", proposal, true);
  db.exec("CREATE TRIGGER fail_bank BEFORE INSERT ON bank_entries WHEN NEW.question='问题二？' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const request = { ...proposal, previewToken: preview.previewToken, idempotencyKey: "bank-rollback-test" };
  await fails("save_bank_import", request, "INTERNAL");
  expect(db.prepare("SELECT count(*) n FROM bank_entries").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) n FROM mcp_operation_results").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_bank"); await ok("save_bank_import", request);
  const large = { ...proposal, text: Array.from({ length: 500 }, (_, i) => `请说明事务场景 ${i} 的处理方式？`).join("\n") };
  const largePreview = await context("preview_bank_import", large, true);
  await ok("save_bank_import", { ...large, previewToken: largePreview.previewToken, idempotencyKey: "large-bank-import" });
  const result = await context("get_bank_import_result", { idempotencyKey: "large-bank-import" });
  expect(result.value.items).toHaveLength(500); expect(new Set(result.value.items.map((row: { id: number }) => row.id)).size).toBe(500);
});

it("creates and renames categories, moves a notebook entry, and preserves its original answer and note", async () => {
  db.exec(`INSERT INTO notebook_entries(id,source,source_id,source_label,question,answer,comment,reference,scores,created_at,updated_at)
    VALUES(1,'drill',1,'来源','事务如何回滚？','我的原答','反馈','参考','{"depth":7,"structure":7,"authenticity":7,"completeness":7}','','');
    INSERT INTO notebook_notes(notebook_id,content,created_at,updated_at) VALUES(1,'独立补充笔记','','');`);
  const category = await ok<{ id: number }>("create_notebook_category", { name: "数据库专题", expectedRevision: (await context("get_notebook_organization_context", {})).revision, idempotencyKey: "new-notebook-category" });
  await ok("rename_notebook_category", { categoryId: category.id, name: "数据库与事务", expectedRevision: (await context("get_notebook_organization_context", { categoryId: category.id })).revision, idempotencyKey: "rename-notebook-category" });
  const before = db.prepare("SELECT * FROM notebook_entries WHERE id=1").get();
  const move = { notebookId: 1, categoryId: category.id, expectedRevision: (await context("get_notebook_organization_context", { notebookId: 1 })).revision, idempotencyKey: "move-notebook-category" };
  await ok("move_notebook_entry", move); await connect(); await ok("move_notebook_entry", move);
  expect(db.prepare("SELECT * FROM notebook_entries WHERE id=1").get()).toMatchObject({ ...before, category_id: category.id, updated_at: expect.any(String) });
  expect(db.prepare("SELECT content FROM notebook_notes WHERE notebook_id=1").get()).toEqual({ content: "独立补充笔记" });
  const web = await import("@/app/api/notebook/categories/[id]/route");
  expect(await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: String(category.id) }) })).json()).toMatchObject({ name: "数据库与事务", entry_count: 1 });
  const missing = await web.PATCH(new Request("http://localhost/api/fixture", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "数据库与事务" }) }), { params: Promise.resolve({ id: "99999" }) });
  expect(missing.status).toBe(404);
});

it("updates material source references, exposes them on the Web and rejects an older summary preview", async () => {
  const summary = { projectId: 1, mode: "full", expectedRevision: (await context("get_project_summary_context", { projectId: 1 })).revision,
    result: { overview: "数据工具", architecture: "SQLite", highlights: "", responsibilities: "参与校验", challenges: "", techStack: "SQLite", brief: "数据工具", achievements: ["参与 SQLite 校验。"] } };
  const old = await context("preview_project_summary", summary, true);
  const proposal = { projectId: 1, materialId: 1, expectedRevision: (await context("get_project_material_context", { projectId: 1, materialId: 1 })).revision, filename: "访谈记录/开发者确认.md" };
  const preview = await context("preview_project_material_edit", proposal, true);
  await ok("save_project_material_edit", { ...proposal, previewToken: preview.previewToken, idempotencyKey: "material-reference" });
  await fails("save_project_summary", { ...summary, previewToken: old.previewToken, idempotencyKey: "old-summary-material" }, "CONFLICT");
  const web = await import("@/app/api/projects/[id]/materials/[mid]/route");
  expect(await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: "1", mid: "1" }) })).json()).toMatchObject({ filename: proposal.filename, content: "参与 SQLite 校验。" });
});

it("captures only a configured repository, reconnects and persists traceable selected source files", async () => {
  const repo = path.join(directory, "fixture-repo"); fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"evidence-fixture"}');
  fs.writeFileSync(path.join(repo, "src", "transaction.ts"), "export function rollback() { return '参与校验'; }\n");
  fs.writeFileSync(path.join(repo, ".env"), "PRIVATE_VALUE=fixture-not-to-collect");
  vi.stubEnv("RESUME_LIFE_MCP_REPO_ROOTS", JSON.stringify([repo]));
  const expectedCatalogRevision = (await context("get_repository_catalog", {})).revision;
  const expectedProjectRevision = (await context("get_project_material_context", { projectId: 1 })).revision;
  const request = { projectId: 1, repositoryIndex: 0, expectedCatalogRevision, expectedProjectRevision, idempotencyKey: "repository-capture" };
  const saved = await ok("capture_project_repository", request); expect(saved.fileCount).toBeGreaterThan(0);
  const snapshot = await context("get_repository_capture", { idempotencyKey: request.idempotencyKey });
  expect(snapshot.value.snapshot).not.toContain("fixture-not-to-collect");
  const selected = snapshot.value.files.find((file: { locator: string }) => file.locator.endsWith("src/transaction.ts")); expect(selected).toBeDefined();
  await connect(); expect(await ok("capture_project_repository", request)).toEqual(saved);
  const evidence = { projectId: 1, captureKey: request.idempotencyKey, fileIndexes: [selected.index], expectedCaptureRevision: snapshot.revision, expectedProjectRevision, idempotencyKey: "repository-evidence" };
  const material = await ok<{ materialIds: number[] }>("save_repository_evidence", evidence);
  await connect(); expect(await ok("save_repository_evidence", evidence)).toEqual(material);
  const row = db.prepare("SELECT filename,content FROM project_materials WHERE id=?").get(material.materialIds[0]!) as { filename: string; content: string };
  expect(row.filename).toContain("src/transaction.ts"); expect(row.content).toContain(selected.sha256); expect(row.content).toContain("export function rollback");
  vi.stubEnv("RESUME_LIFE_MCP_REPO_ROOTS", "[]");
  await fails("get_repository_capture", { idempotencyKey: request.idempotencyKey }, "FORBIDDEN");
});

const jargonResult = { target_summary: "例行协作职责", punchline: "未识别到明确风险线索", overall_risk_score: 12,
  risk_ratings: { overtime: 1, stability: 2, resources: 1, management: 1 }, items: [],
  company_profile: { team_style: "信息不足", risk_flags: [], culture_summary: "原文只说明常规协作，不能据此判断实际团队情况。" }, golden_questions: [] };
it("validates and saves jargon results with identical Web records and unified search discovery", async () => {
  const text = "参与 SQLite 校验，与同事进行例行协作。";
  const input = { text, expectedRevision: (await context("get_jargon_generation_context", { text })).revision, result: jargonResult, idempotencyKey: "jargon-delivery" };
  await fails("save_jargon_result", { ...input, result: { ...jargonResult, overall_risk_score: 90 } }, "INVALID_ARGUMENT");
  const saved = await ok<{ id: number }>("save_jargon_result", input); await connect(); expect(await ok("save_jargon_result", input)).toEqual(saved);
  expect((await context("get_career_record", { kind: "jargon_decoding", id: saved.id })).value.record.source_text).toBe(text);
  const web = await import("@/app/api/tools/jargon-decodings/[id]/route");
  expect(await (await web.GET(new Request("http://localhost/api/fixture"), { params: Promise.resolve({ id: String(saved.id) }) })).json()).toMatchObject({ source_text: text });
  const search = await ok<{ careerRecords: Bag[] }>("search_records", { query: "SQLite" });
  expect(search.careerRecords).toContainEqual(expect.objectContaining({ id: saved.id, fullContent: { tool: "get_career_record", id: saved.id, kind: "jargon_decoding" } }));
  await connect(new Set(["search_records"]));
  expect(await ok("search_records", { query: "SQLite" })).toMatchObject({ careerRecords: [], projects: [], resumes: [] });
});

it("exports the previewed anonymized portfolio ZIP and invalidates changed selections", async () => {
  const options = { resumeId: 1, versionId, selectedProjects: [{ projectId: 1 }], siteTemplate: "sidebar" };
  const preview = await context("get_portfolio_context", { options });
  expect(preview.value.output.candidateName).not.toBe("王小明");
  const request = { options, expectedRevision: preview.revision, idempotencyKey: "portfolio-delivery" };
  const artifact = await ok<{ artifactId: string }>("export_portfolio", request);
  const zip = await JSZip.loadAsync(await artifactBytes(artifact.artifactId));
  const html = await zip.file("index.html")!.async("string");
  expect(html).not.toContain("13800138000"); expect(html).not.toContain("王小明"); expect(html).toContain("数据工具");
  await connect(); expect(await ok("export_portfolio", request)).toMatchObject(artifact);
  db.exec("UPDATE projects SET name='更新后的项目' WHERE id=1");
  await fails("export_portfolio", { ...request, idempotencyKey: "portfolio-after-change" }, "CONFLICT");
});

it("discovers all workflows with actionable missing permissions and matching presets", async () => {
  const catalog = await context("get_workflow_catalog", {});
  expect(catalog.value.workflows.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining(["intro-generation", "project-summary", "practice-generation", "review-practice", "series-create", "series-round", "series-advance", "series-finalize", "salary-training", "resume-delivery"]));
  expect(catalog.value.workflows.every((row: { available: boolean }) => row.available)).toBe(true);
  expect(catalog.value.workflows.find((row: { id: string }) => row.id === "resume-delivery").compatiblePresets).toContain("collaboration");
  await connect(null, false);
  const limited = await context("get_workflow_catalog", { workflowId: "resume-delivery" });
  expect(limited.value.workflows[0].available).toBe(false);
  expect(limited.value.workflows[0].missingTools).toContain("publish_resume_version");
});

it.each(["null", "[]", "damaged"])("requires explicit repair of corrupted style %s before changing layout", async raw => {
  db.prepare("UPDATE resumes SET style_overrides=? WHERE id=1").run(raw);
  const proposal = { resumeId: 1, expectedRevision: (await context("get_resume_layout_context", { resumeId: 1 })).revision, moduleOrder: ["skills", "basic", "summary"] };
  await fails("preview_resume_layout", proposal, "INVALID_ARGUMENT");
  const repair = { ...proposal, styleOverrides: {} };
  const preview = await context("preview_resume_layout", repair, true);
  await ok("save_resume_layout", { ...repair, previewToken: preview.previewToken, idempotencyKey: "explicit-style-repair" });
  expect((await import("@/lib/resumes")).loadResume(1)!.resume.styleCorrupted).toBeUndefined();
});

it("exports a published custom style after its live template has been removed", async () => {
  const { DEFAULT_STYLE } = await import("@/lib/templates");
  db.prepare("INSERT INTO resume_templates(id,name,style,created_at,updated_at) VALUES(1,'已发布模板',?,'','')").run(JSON.stringify({ ...DEFAULT_STYLE, accent: "#af4e3c" }));
  db.exec("UPDATE resumes SET template='custom:1' WHERE id=1");
  const published = await ok<{ id: number }>("publish_resume_version", { resumeId: 1, name: "冻结样式", expectedRevision: (await context("get_resume_version_context", { resumeId: 1 })).revision, idempotencyKey: "custom-template-version" });
  db.exec("DELETE FROM resume_templates WHERE id=1");
  const source = { resumeId: 1, versionId: published.id };
  const preview = await context("get_resume_export_context", { source });
  expect(preview.value.output.resume.resolved_style.accent).toBe("#af4e3c");
  const artifact = await ok<{ artifactId: string }>("export_resume", { source, expectedRevision: preview.revision, format: "docx", idempotencyKey: "frozen-template-export" });
  const zip = await JSZip.loadAsync(await artifactBytes(artifact.artifactId));
  expect(await zip.file("word/document.xml")!.async("string")).toMatch(/af4e3c/i);
});

it("rejects tampered artifacts and files without a committed receipt", async () => {
  const source = { resumeId: 1, versionId };
  const request = { source, expectedRevision: (await context("get_resume_export_context", { source })).revision, format: "markdown", idempotencyKey: "artifact-tamper-fixture" };
  const artifact = await ok<{ artifactId: string }>("export_resume", request);
  const filename = path.join(directory, "mcp-artifacts", artifact.artifactId + ".bin");
  await artifactBytes(artifact.artifactId); // 先命中校验缓存，再以同长度改写且恢复 mtime。
  const stat = fs.statSync(filename);
  const bytes = fs.readFileSync(filename); bytes[0] = bytes[0]! ^ 1; fs.writeFileSync(filename, bytes);
  fs.utimesSync(filename, stat.atime, stat.mtime);
  await connect();
  await fails("read_export_artifact", { artifactId: artifact.artifactId }, "CONFLICT");
  db.exec("CREATE TRIGGER fail_artifact BEFORE INSERT ON mcp_creation_receipts WHEN NEW.tool='export_resume' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  const uncommittedKey = "artifact-uncommitted-fixture";
  await fails("export_resume", { ...request, idempotencyKey: uncommittedKey }, "INTERNAL");
  const uncommittedId = createHash("sha256").update(JSON.stringify(["export_resume", uncommittedKey])).digest("hex");
  await fails("read_export_artifact", { artifactId: uncommittedId }, "NOT_FOUND");
  db.exec("DROP TRIGGER fail_artifact");
  const committed = await ok<{ artifactId: string }>("export_resume", { ...request, idempotencyKey: uncommittedKey });
  expect((await artifactBytes(committed.artifactId)).toString()).toContain("SQLite");
});

it("reads a multi-megabyte artifact once while returning all chunks with the correct checksum", async () => {
  const { createMcpArtifact, readMcpArtifact } = await import("@/lib/mcp-artifacts");
  const bytes = Buffer.alloc(4 * 1024 * 1024, 65);
  const artifact = await createMcpArtifact("export_resume", "linear-artifact-read", {}, async () => ({ bytes,
    filename: "fixture.md", mimeType: "text/markdown", sourceRevision: "a".repeat(64), validate() {} }));
  const originalRead = fs.readSync;
  let totalRead = 0;
  const spy = vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(originalRead, fs, args) as number;
    totalRead += count; return count;
  });
  const digest = createHash("sha256");
  let offset = 0, authorizations = 0;
  try {
    while (true) {
      const chunk = readMcpArtifact({ artifactId: artifact.artifactId, offset }, () => { authorizations++; });
      digest.update(Buffer.from(chunk.data, "base64"));
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    }
  } finally { spy.mockRestore(); }
  expect(digest.digest("hex")).toBe(artifact.sha256);
  expect(authorizations).toBe(Math.ceil(bytes.length / 8000));
  expect(totalRead).toBeGreaterThanOrEqual(bytes.length);
  expect(totalRead).toBeLessThan(bytes.length * 2);
  expect(() => readMcpArtifact({ artifactId: artifact.artifactId }, () => { throw new Error("access revoked"); })).toThrow("access revoked");
  db.exec("DELETE FROM mcp_creation_receipts WHERE request_key='linear-artifact-read'");
  expect(() => readMcpArtifact({ artifactId: artifact.artifactId }, () => {})).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
});

it.each([{ size: 8192, count: 17 }, { size: 15 * 1024 * 1024, count: 3 }])("bounds verified cache capacity for $count files of $size bytes", async ({ size, count }) => {
  const { createMcpArtifact, readMcpArtifact } = await import("@/lib/mcp-artifacts");
  const bytes = Buffer.alloc(size, 65);
  let firstId = "";
  for (let i = 0; i < count; i++) {
    const artifact = await createMcpArtifact("export_resume", `cache-capacity-${i}`, {}, async () => ({ bytes,
      filename: "fixture.md", mimeType: "text/markdown", sourceRevision: "a".repeat(64), validate() {} }));
    firstId ||= artifact.artifactId;
    readMcpArtifact({ artifactId: artifact.artifactId }, () => {});
  }
  const originalRead = fs.readSync;
  let totalRead = 0;
  const spy = vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const read = Reflect.apply(originalRead, fs, args) as number; totalRead += read; return read;
  });
  try { expect(readMcpArtifact({ artifactId: firstId }, () => {}).data).toBe(bytes.subarray(0, 8000).toString("base64")); }
  finally { spy.mockRestore(); }
  expect(totalRead).toBeGreaterThanOrEqual(size); // 被淘汰的首个文件必须重新读取并校验。
  expect(totalRead).toBeLessThan(size + 16384);
});

it("limits concurrent renders and releases capacity after a failure", async () => {
  const { createMcpArtifact } = await import("@/lib/mcp-artifacts");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const render = async () => { await gate; return { bytes: Buffer.from("bounded"), filename: "fixture.md", mimeType: "text/markdown", sourceRevision: "a".repeat(64), validate: () => {} }; };
  const first = createMcpArtifact("export_resume", "bounded-render-one", {}, render);
  const second = createMcpArtifact("export_resume", "bounded-render-two", {}, async () => { await gate; throw new Error("render fixture failure"); });
  await expect(createMcpArtifact("export_resume", "bounded-render-three", {}, render)).rejects.toMatchObject({ code: "BUSY" });
  release();
  expect((await Promise.allSettled([first, second])).map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  await expect(createMcpArtifact("export_resume", "bounded-render-three", {}, render)).resolves.toMatchObject({ byteLength: 7 });
});

it.each(["cancel", "timeout", "source"])("does not commit an artifact after asynchronous %s invalidation", async reason => {
  const { createMcpArtifact } = await import("@/lib/mcp-artifacts");
  const { withOperationLimits } = await import("@/lib/operation-deadline");
  const { McpOperationError } = await import("@/lib/mcp-errors");
  const controller = new AbortController();
  const promise = withOperationLimits({ signal: controller.signal, ...(reason === "timeout" ? { deadline: performance.now() - 1 } : {}) }, () =>
    createMcpArtifact("export_resume", "invalidated-render-key", {}, async () => {
      await Promise.resolve();
      if (reason === "cancel") controller.abort();
      return { bytes: Buffer.from("uncommitted"), filename: "fixture.md", mimeType: "text/markdown", sourceRevision: "a".repeat(64),
        validate: () => { if (reason === "source") throw new McpOperationError("CONFLICT", "来源已改变"); } };
    }));
  await expect(promise).rejects.toBeInstanceOf(Error);
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_creation_receipts").get()).toEqual({ n: 0 });
});

it("restores business records atomically while invalidating cached batch results and artifacts", async () => {
  const proposal = { direction: "恢复示例", kind: "tech", text: "SQLite 事务怎么验证？" };
  const bank = { ...proposal, previewToken: (await context("preview_bank_import", proposal, true)).previewToken, idempotencyKey: "restore-bank-fixture" };
  await ok("save_bank_import", bank);
  const source = { resumeId: 1, versionId };
  const artifact = await ok<{ artifactId: string }>("export_resume", { source, expectedRevision: (await context("get_resume_export_context", { source })).revision, format: "markdown", idempotencyKey: "restore-artifact-fixture" });
  const { createBackupRecordStream } = await import("@/lib/backup-records");
  const { stageBackupRecordStream } = await import("@/lib/backup-staging");
  const { restoreAllData } = await import("@/lib/backup");
  const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  try {
    expect(staged.manifest.tables.every(table => !table.startsWith("mcp_"))).toBe(true);
    let checks = 0;
    expect(() => restoreAllData(staged, true, () => { if (++checks === 2) throw new Error("restore fixture failure"); })).toThrow("restore fixture failure");
    expect((await context("get_bank_import_result", { idempotencyKey: bank.idempotencyKey })).value.createdCount).toBe(1);
    restoreAllData(staged, true);
    expect(db.prepare("SELECT COUNT(*) n FROM mcp_operation_results").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT question FROM bank_entries WHERE direction='恢复示例'").get()).toEqual({ question: proposal.text });
    await fails("get_bank_import_result", { idempotencyKey: bank.idempotencyKey }, "CONFLICT");
    await fails("save_bank_import", bank, "CONFLICT");
    await fails("read_export_artifact", { artifactId: artifact.artifactId }, "CONFLICT");
  } finally { staged.dispose(); }
});
