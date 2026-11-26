import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readContext, readAllPages } from "../../examples/mcp/helpers.mjs";

type Bag = Record<string, unknown>;
type Capture = { revision: string; value: { files: { index: number; locator: string; content: string }[] } };
let directory: string, repository: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer;
async function call(name: string, args: Bag = {}): Promise<Bag> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify({ name, result: result.structuredContent })).not.toBe(true);
  return (result.structuredContent as { data: Bag }).data;
}
async function fails(name: string, args: Bag, code: string) {
  expect((await client.callTool({ name, arguments: args })).structuredContent).toMatchObject({ ok: false, error: { code } });
}
async function connect(allowlist: Set<string> | null = null) {
  await client?.close(); await server?.close();
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist, writeEnabled: true, llmEnabled: false, timeoutMs: 30_000 });
  client = new Client({ name: "evidence-update-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-evidence-update-test-"));
  repository = path.join(directory, "repository"); fs.mkdirSync(repository);
  fs.writeFileSync(path.join(repository, "package.json"), '{"name":"fixture"}');
  fs.writeFileSync(path.join(repository, "main.ts"), "export const count = 1;");
  fs.writeFileSync(path.join(repository, "removed.ts"), "export const oldFeature = true;");
  fs.writeFileSync(path.join(repository, "limited.ts"), "export const note = '已采集';");
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  vi.stubEnv("RESUME_LIFE_MCP_REPO_ROOTS", JSON.stringify([repository]));
  db = (await import("@/lib/db")).getDb(); db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'源码项目','','')");
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-evidence-update-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
async function capture(key: string, baselineCaptureKey?: string): Promise<Capture> {
  await call("capture_project_repository", { projectId: 1, repositoryIndex: 0, baselineCaptureKey, idempotencyKey: key,
    expectedCatalogRevision: (await readContext(call, "get_repository_catalog")).revision,
    expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId: 1 })).revision });
  return readContext(call, "get_repository_capture", { idempotencyKey: key });
}
async function seed(key = "base-capture") {
  const result = await capture(key);
  await call("save_repository_evidence", { projectId: 1, captureKey: key, fileIndexes: result.value.files.filter(file => file.locator.endsWith(".ts")).map(file => file.index),
    expectedCaptureRevision: result.revision, expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId: 1 })).revision,
    idempotencyKey: key + "-save" });
  return result;
}
async function edit(source: Bag, selections: Bag[]) {
  const basis = await readContext(call, "get_repository_evidence_diff", source);
  const proposal = { ...source, selections, expectedRevision: basis.revision };
  const preview = await readContext(call, "preview_repository_evidence_update", proposal, true);
  return { basis, preview, input: { ...proposal, previewToken: preview.previewToken, idempotencyKey: "save-evidence-update" } };
}
const source = { projectId: 1, baseCaptureKey: "base-capture", nextCaptureKey: "next-capture" };
const locator = (file: string) => "repository/" + file;

it("diffs actual files, selectively updates materials, retains history and invalidates old summary proposals", async () => {
  await seed();
  const summary = await readContext(call, "get_project_summary_context", { projectId: 1, mode: "full" });
  const oldProposal = { projectId: 1, mode: "full", expectedRevision: summary.revision,
    result: { overview: "源码项目", architecture: "TypeScript", highlights: "", responsibilities: "参与维护", challenges: "", techStack: "TypeScript", brief: "源码维护", achievements: ["参与工具维护"] } };
  const oldPreview = await readContext(call, "preview_project_summary", oldProposal, true);
  fs.writeFileSync(path.join(repository, "main.ts"), "export const count = 2;");
  fs.writeFileSync(path.join(repository, "added.ts"), "export const added = true;");
  fs.unlinkSync(path.join(repository, "removed.ts"));
  fs.writeFileSync(path.join(repository, "limited.ts"), Buffer.from([0, 1, 2]));
  await capture("next-capture", "base-capture");
  const { basis, preview, input } = await edit(source, [
    { locator: locator("main.ts"), action: "upsert" }, { locator: locator("added.ts"), action: "upsert" }, { locator: locator("removed.ts"), action: "remove" },
  ]);
  expect(basis.value.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ locator: locator("main.ts"), kind: "modified" }),
    expect.objectContaining({ locator: locator("added.ts"), kind: "added" }),
    expect.objectContaining({ locator: locator("removed.ts"), kind: "deleted" }),
    expect.objectContaining({ locator: locator("limited.ts"), kind: "not-captured" }),
  ]));
  expect(preview.value.summaryRequiresReview).toBe(true);
  const saved = await call("save_repository_evidence_update", input); await connect(); expect(await call("save_repository_evidence_update", input)).toEqual(saved);
  const rows = db.prepare("SELECT id,filename,content FROM project_materials ORDER BY id").all();
  expect(rows).toHaveLength(3);
  expect(rows.find(row => row.filename === locator("main.ts"))?.content).toContain("count = 2");
  expect(rows.find(row => row.filename === locator("limited.ts"))?.content).toContain("已采集");
  const history = await readAllPages(call, "list_repository_evidence_history", { projectId: 1, limit: 2 });
  expect(history).toHaveLength(6);
  const older = history.find((row: Bag) => row.locator === locator("main.ts") && row.change_kind === "added");
  const full = await readContext(call, "get_repository_evidence_version", { projectId: 1, id: older.id });
  expect(full.value.content).toBe("export const count = 1;");
  await fails("save_project_summary", { ...oldProposal, previewToken: oldPreview.previewToken, idempotencyKey: "obsolete-summary" }, "CONFLICT");
  const web = await import("@/app/api/projects/[id]/materials/[mid]/route");
  const main = rows.find(row => row.filename === locator("main.ts"))!;
  expect(await (await web.GET(new Request("http://localhost/material"), { params: Promise.resolve({ id: "1", mid: String(main.id) }) })).json()).toMatchObject({ content: main.content });
});

it("deduplicates unchanged content across distinct captures instead of comparing capture timestamps", async () => {
  await seed();
  db.exec("UPDATE mcp_operation_results SET result_json=json_set(result_json,'$.capturedAt','2000-01-01T00:00:00.000Z') WHERE tool='capture_project_repository'");
  const before = db.prepare("SELECT * FROM project_materials ORDER BY id").all();
  const next = await capture("next-capture", "base-capture");
  await call("save_repository_evidence", { projectId: 1, captureKey: "next-capture", fileIndexes: next.value.files.filter(row => row.locator.endsWith(".ts")).map(row => row.index),
    expectedCaptureRevision: next.revision, expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId: 1 })).revision, idempotencyKey: "repeated-evidence" });
  expect(db.prepare("SELECT * FROM project_materials ORDER BY id").all()).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) n FROM project_repository_evidence").get()).toEqual({ n: 3 });
});

it("adopts unchanged v12 evidence using the exact baseline without duplicating or silently replacing old materials", async () => {
  await seed();
  db.exec("DELETE FROM project_repository_evidence");
  const original = db.prepare("SELECT * FROM project_materials ORDER BY id").all();
  const next = await capture("next-capture", "base-capture");
  await call("save_repository_evidence", { projectId: 1, captureKey: "next-capture", fileIndexes: next.value.files.filter(row => row.locator.endsWith(".ts")).map(row => row.index),
    expectedCaptureRevision: next.revision, expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId: 1 })).revision, idempotencyKey: "adopt-v12-evidence" });
  expect(db.prepare("SELECT * FROM project_materials ORDER BY id").all()).toEqual(original);
  expect(db.prepare("SELECT COUNT(*) n FROM project_repository_evidence").get()).toEqual({ n: 3 });
  expect(db.prepare("SELECT DISTINCT capture_key FROM project_repository_evidence").all()).toEqual([{ capture_key: "base-capture" }]);
  db.exec("DELETE FROM project_repository_evidence");
  fs.writeFileSync(path.join(repository, "main.ts"), "export const count = 12;");
  const changed = await capture("changed-capture", "base-capture");
  await fails("save_repository_evidence", { projectId: 1, captureKey: "changed-capture", fileIndexes: [changed.value.files.find(row => row.locator === locator("main.ts"))!.index],
    expectedCaptureRevision: changed.revision, expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId: 1 })).revision, idempotencyKey: "refuse-v12-replacement" }, "CONFLICT");
  expect(db.prepare("SELECT * FROM project_materials ORDER BY id").all()).toEqual(original);
});

it("refuses unobserved removals, changed proposals and concurrent material edits without occupying the key", async () => {
  await seed(); fs.unlinkSync(path.join(repository, "removed.ts")); fs.writeFileSync(path.join(repository, "main.ts"), "export const count = 3;");
  await capture("next-capture");
  const basis = await readContext(call, "get_repository_evidence_diff", source);
  await fails("preview_repository_evidence_update", { ...source, expectedRevision: basis.revision, selections: [{ locator: locator("removed.ts"), action: "remove" }] }, "INVALID_ARGUMENT");
  const { input } = await edit(source, [{ locator: locator("main.ts"), action: "upsert" }]);
  await fails("save_repository_evidence_update", { ...input, selections: [{ locator: locator("package.json"), action: "upsert" }] }, "CONFLICT");
  db.prepare("UPDATE project_materials SET content=content||'\\n人工补充事实' WHERE filename=?").run(locator("main.ts"));
  await fails("save_repository_evidence_update", input, "CONFLICT");
  const fresh = await edit(source, [{ locator: locator("main.ts"), action: "upsert" }]);
  expect(fresh.basis.value.changes.find((row: Bag) => row.locator === locator("main.ts")).materialEdited).toBe(true);
  const original = db.prepare("SELECT * FROM project_materials ORDER BY id").all();
  db.exec("CREATE TRIGGER fail_evidence BEFORE INSERT ON project_repository_evidence BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await fails("save_repository_evidence_update", fresh.input, "INTERNAL");
  expect(db.prepare("SELECT * FROM project_materials ORDER BY id").all()).toEqual(original);
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='save_repository_evidence_update'").get()).toBeUndefined();
  db.exec("DROP TRIGGER fail_evidence"); await call("save_repository_evidence_update", fresh.input);
  const last = db.prepare("SELECT previous_material_snapshot FROM project_repository_evidence ORDER BY id DESC LIMIT 1").get();
  expect(String(last?.previous_material_snapshot)).toContain("人工补充事实");
});

it("keeps historical evidence through cache expiry, repository removal and actual backup restore", async () => {
  await seed(); const rows = db.prepare("SELECT * FROM project_repository_evidence ORDER BY id").all();
  db.exec("UPDATE mcp_creation_receipts SET created_at='2000-01-01T00:00:00.000Z'");
  const preview = await call("preview_mcp_cache_cleanup"); await call("cleanup_mcp_cache", { previewToken: preview.previewToken });
  await fails("get_repository_capture", { idempotencyKey: "base-capture" }, "NOT_FOUND");
  vi.stubEnv("RESUME_LIFE_MCP_REPO_ROOTS", "[]");
  const history = await readAllPages(call, "list_repository_evidence_history", { projectId: 1 }); expect(history).toHaveLength(3);
  expect((await readContext(call, "get_repository_evidence_version", { projectId: 1, id: history[0].id })).value.content).toBeTruthy();
  const { createBackupRecordStream } = await import("@/lib/backup-records");
  const { stageBackupRecordStream } = await import("@/lib/backup-staging");
  const { restoreAllData } = await import("@/lib/backup");
  const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  try { restoreAllData(staged, true); } finally { staged.dispose(); }
  expect(db.prepare("SELECT * FROM project_repository_evidence ORDER BY id").all()).toEqual(rows);
  expect((await readAllPages(call, "list_repository_evidence_history", { projectId: 1 })).length).toBe(3);
  const { validateProjectMaterialTableProvenance } = await import("@/lib/backup-domain");
  db.exec("UPDATE project_repository_evidence SET content='被篡改' WHERE id=1");
  expect(() => validateProjectMaterialTableProvenance(db)).toThrow("仓库证据历史无效");
});

it("observes deletion when every source file and project marker has disappeared", async () => {
  await seed();
  for (const file of fs.readdirSync(repository)) fs.unlinkSync(path.join(repository, file));
  await capture("next-capture", "base-capture");
  const basis = await readContext(call, "get_repository_evidence_diff", source);
  expect(basis.value.changes.every((row: Bag) => row.kind === "deleted")).toBe(true);
  const { input } = await edit(source, ["main.ts", "limited.ts", "removed.ts"].map(file => ({ locator: locator(file), action: "remove" })));
  await call("save_repository_evidence_update", input);
  expect(db.prepare("SELECT COUNT(*) n FROM project_materials").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) n FROM project_repository_evidence").get()).toEqual({ n: 6 });
});

it("does not follow replacement directory links and enforces the complete read dependency set", async () => {
  await seed();
  const { observeMissingRepositoryFile } = await import("@/lib/repo-scanner/source-presence");
  const outside = path.join(directory, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repository, "redirect"), process.platform === "win32" ? "junction" : "dir");
  expect(await observeMissingRepositoryFile(repository, "redirect/missing.ts")).toBe("not-captured");
  expect(await observeMissingRepositoryFile(repository, "../outside/missing.ts")).toBe("not-captured");
  const tools = ["get_project", "list_project_materials", "get_project_material_context", "get_repository_catalog", "get_repository_capture", "get_repository_evidence_diff"];
  await capture("next-capture", "base-capture");
  await connect(new Set(tools)); await readContext(call, "get_repository_evidence_diff", source);
  await connect(new Set(tools.filter(name => name !== "get_repository_capture"))); await fails("get_repository_evidence_diff", source, "FORBIDDEN");
});
