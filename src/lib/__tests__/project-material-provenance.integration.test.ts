import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { emptySummary } from "../summary";
import type { DocumentTableProvenance } from "../document-table-provenance";

const model = vi.hoisted(() => ({ chatStream: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), chatStream: model.chatStream }));

const prefix = "resume-life-material-provenance-";
let directory: string;
let db: DatabaseSync;
const projectParams = (id = "1") => ({ params: Promise.resolve({ id }) });
const materialParams = (id: number) => ({ params: Promise.resolve({ id: "1", mid: String(id) }) });
const request = (body: unknown, method = "POST") => new Request("http://localhost/api/projects/1/materials", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const plainProvenance = (text: string): DocumentTableProvenance => ({ version: 1, format: "docx", offsetUnit: "utf16", textSha256: hash(text), markers: [] });
const markerText = "[表格]\n\n[第 1 行]\n\n[第 1 行，第 1 列]\n\n本人参与测试，未上线。\n\n[表格结束]\n\n";
const nativeProvenance = (): DocumentTableProvenance => ({ ...plainProvenance(markerText), markers: [...markerText.matchAll(/\[表格\]|\[表格结束\]|\[第 [^\]]+\]/g)].map(match => ({ start: match.index, end: match.index + match[0].length })) });

beforeEach(async () => {
  vi.resetModules();
  model.chatStream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'来源项目','','original'),(2,'来源项目','','original')");
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe test cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function docx(native: boolean) {
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const body = native
    ? `<w:tbl><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc>${p("本人参与测试，未上线。")}</w:tc></w:tr></w:tbl>`
    : markerText.slice(0, -2).split("\n\n").map(p).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "arraybuffer" });
}

async function upload(native: boolean, projectId = "1") {
  const form = new FormData();
  form.set("file", new Blob([await docx(native)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "source.docx");
  form.set("title", "同一材料标题");
  const { POST } = await import("@/app/api/projects/[id]/materials/route");
  const response = await POST(new Request(`http://localhost/api/projects/${projectId}/materials`, { method: "POST", body: form }), projectParams(projectId));
  expect(response.status).toBe(201);
  return (await response.json()).id as number;
}

async function create(content = markerText, tableProvenance = nativeProvenance()) {
  const { createProjectMaterial } = await import("../project-materials");
  return createProjectMaterial(1, { title: "材料", source: "file", filename: "source.docx", content, tableProvenance })!;
}

describe("project material native table provenance", () => {
  it("keeps identical DOCX display text distinct through real upload, SQLite, source capture and safe model assembly", async () => {
    const nativeId = await upload(true), literalId = await upload(false, "2");
    const { loadProjectMaterial } = await import("../project-materials");
    const native = loadProjectMaterial(1, nativeId)!, literal = loadProjectMaterial(2, literalId)!;
    expect(native.content).toBe(markerText); expect(literal.content).toBe(markerText);
    expect(native.tableProvenance?.markers).toHaveLength(4);
    expect(literal.tableProvenance).toEqual(plainProvenance(markerText));
    const { captureProjectSummaryInput } = await import("../project-summary-history");
    const { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT } = await import("../project-summary-llm");
    const { checkSafeModelInput } = await import("../safe-llm");
    const messages = (id: number) => {
      const input = captureProjectSummaryInput(id, 60_000);
      return checkSafeModelInput(PROJECT_SUMMARY_SYSTEM_PROMPT, buildProjectSummaryMessages({ projectName: input.project.name, materialText: input.materialText, archive: emptySummary() }));
    };
    expect(messages(1)).not.toEqual(messages(2));
    expect(db.prepare("SELECT content FROM project_materials ORDER BY id").all()).toEqual([{ content: markerText }, { content: markerText }]);
  });

  it("preserves provenance for same-content edits and clears it atomically on content change with fresh revision", async () => {
    const id = await create();
    const { loadProjectMaterial } = await import("../project-materials");
    const { PATCH } = await import("@/app/api/projects/[id]/materials/[mid]/route");
    const original = loadProjectMaterial(1, id)!;
    const renamed = await PATCH(request({ title: "改标题", content: markerText, expectedRevision: original.revision }, "PATCH"), materialParams(id));
    expect(renamed.status).toBe(200);
    const afterTitle = loadProjectMaterial(1, id)!;
    expect(afterTitle.tableProvenance).toEqual(original.tableProvenance);
    expect(afterTitle.revision).toBe((await renamed.json()).revision);
    const modified = markerText + "人工补充。";
    const edited = await PATCH(request({ title: "改标题", content: modified, expectedRevision: afterTitle.revision }, "PATCH"), materialParams(id));
    expect(edited.status).toBe(200);
    const afterContent = loadProjectMaterial(1, id)!;
    expect(afterContent.content).toBe(modified); expect(afterContent.tableProvenance).toBeUndefined();
    expect(afterContent.revision).toBe((await edited.json()).revision);
    expect(db.prepare("SELECT * FROM project_material_table_provenance").all()).toEqual([]);
    expect((await PATCH(request({ title: "旧稿", content: markerText, expectedRevision: afterTitle.revision }, "PATCH"), materialParams(id))).status).toBe(409);
    expect(loadProjectMaterial(1, id)).toEqual(afterContent);
  });

  it("binds provenance-only changes to edit tokens and summary fingerprints while retaining legacy digests", async () => {
    const { createProjectMaterial, loadProjectMaterial, updateProjectMaterial } = await import("../project-materials");
    const history = await import("../project-summary-history");
    const id = createProjectMaterial(1, { title: "材料", content: markerText, source: "paste", filename: "" })!;
    const legacy = loadProjectMaterial(1, id)!;
    const oldSnapshot = history.captureProjectMaterialSnapshot(1);
    expect(oldSnapshot[0]!.digest).toBe(hash("材料\0" + markerText));
    const generated = { ...emptySummary(), responsibilities: "本人参与测试，未上线。" };
    const proposal = history.prepareProjectSummaryProposal(1, generated);
    db.prepare("INSERT INTO project_material_table_provenance (material_id,provenance) VALUES (?,?)").run(id, JSON.stringify(plainProvenance(markerText)));
    const knownLiteral = loadProjectMaterial(1, id)!;
    expect(knownLiteral.revision).not.toBe(legacy.revision);
    expect(history.captureProjectMaterialSnapshot(1)[0]!.digest).not.toBe(oldSnapshot[0]!.digest);
    expect(updateProjectMaterial(1, id, { title: legacy.title, content: markerText, expectedRevision: legacy.revision }).status).toBe("conflict");
    expect(() => history.saveProjectSummary(1, { summary: generated, proposal: { generated, acceptedKeys: ["responsibilities"], source: "ai", materialFingerprint: proposal.materialFingerprint } })).toThrow("材料已更新");
    const { PATCH } = await import("@/app/api/projects/[id]/route");
    const rejected = await PATCH(request({ summary: generated, expectedRevisionId: proposal.revisionId,
      proposal: { generated, acceptedKeys: ["responsibilities"], source: "ai", materialFingerprint: proposal.materialFingerprint } }, "PATCH"), projectParams());
    expect(rejected.status).toBe(409);
    expect(db.prepare("SELECT * FROM project_summary_history").all()).toEqual([]);
  });

  it.each(["full", "resume-only"])("counts table serialization overhead and rejects %s before a model call", async mode => {
    const { createProjectMaterial } = await import("../project-materials");
    const { serializeProjectSummaryMaterial } = await import("../project-summary-llm");
    const block = "[表格]\n\n[第 1 行]\n\n[第 1 行，第 1 列]\n\n本人参与测试。\n\n[表格结束]\n\n";
    const content = block.repeat(210);
    const tableProvenance: DocumentTableProvenance = { ...plainProvenance(content), markers: [...content.matchAll(/\[表格\]|\[表格结束\]|\[第 [^\]]+\]/g)].map(match => ({ start: match.index, end: match.index + match[0].length })) };
    expect(serializeProjectSummaryMaterial({ title: "材料", content }, 0).length).toBeLessThan(60_000);
    expect(serializeProjectSummaryMaterial({ title: "材料", content, tableProvenance }, 0).length).toBeGreaterThan(60_000);
    createProjectMaterial(1, { title: "材料", content, source: "file", filename: "many-tables.docx", tableProvenance });
    const { POST } = await import("@/app/api/projects/[id]/summarize/route");
    const response = await POST(new Request(`http://localhost/api/projects/1/summarize?mode=${mode}`, { method: "POST" }), projectParams());
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain("60000");
    expect(model.chatStream).not.toHaveBeenCalled();
    expect(db.prepare("SELECT content FROM project_materials").get()).toEqual({ content });
  });

  it.each(["tableProvenance", "provenance"])("rejects client %s on both JSON writes without installing or altering provenance", async field => {
    const id = await create();
    const { loadProjectMaterial } = await import("../project-materials");
    const existing = loadProjectMaterial(1, id)!;
    const { POST } = await import("@/app/api/projects/[id]/materials/route");
    const { PATCH } = await import("@/app/api/projects/[id]/materials/[mid]/route");
    const body = { title: "伪造来源", content: markerText, expectedRevision: existing.revision, [field]: plainProvenance(markerText) };
    expect((await POST(request(body), projectParams())).status).toBe(400);
    expect((await PATCH(request(body, "PATCH"), materialParams(id))).status).toBe(400);
    expect(loadProjectMaterial(1, id)).toEqual(existing);
    expect(db.prepare("SELECT count(*) AS count FROM project_materials").get()).toEqual({ count: 1 });
  });

  it("rolls back material creation and content/provenance deletion when the shared transaction fails", async () => {
    const { createProjectMaterial, loadProjectMaterial, updateProjectMaterial } = await import("../project-materials");
    const id = await create(), existing = loadProjectMaterial(1, id)!;
    db.exec("CREATE TEMP TRIGGER reject_project_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
    expect(() => createProjectMaterial(1, { title: "新材料", content: markerText, source: "file", filename: "a.docx", tableProvenance: nativeProvenance() })).toThrow("synthetic write failure");
    expect(() => updateProjectMaterial(1, id, { title: "改变", content: markerText + "改变", expectedRevision: existing.revision })).toThrow("synthetic write failure");
    expect(loadProjectMaterial(1, id)).toEqual(existing);
    expect(db.prepare("SELECT count(*) AS count FROM project_materials").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM project_material_table_provenance").get()).toEqual({ count: 1 });
  });

  it("rejects corrupt stored provenance before generation and reports an internal error without exposing stored text", async () => {
    const id = await create();
    db.prepare("UPDATE project_material_table_provenance SET provenance = ? WHERE material_id = ?").run(JSON.stringify({ ...nativeProvenance(), textSha256: "0".repeat(64) }), id);
    const { captureProjectSummaryInput } = await import("../project-summary-history");
    expect(() => captureProjectSummaryInput(1, 60_000)).toThrow();
    const { GET } = await import("@/app/api/projects/[id]/materials/[mid]/route");
    const response = await GET(new Request(`http://localhost/api/projects/1/materials/${id}`), materialParams(id));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.requestId).toEqual(expect.any(String)); expect(JSON.stringify(body)).not.toContain(markerText);
  });

  it("deletes side provenance through material and project cascade ownership", async () => {
    const first = await create(), second = await create();
    const { DELETE } = await import("@/app/api/projects/[id]/materials/[mid]/route");
    expect((await DELETE(new Request(`http://localhost/api/projects/1/materials/${first}`, { method: "DELETE" }), materialParams(first))).status).toBe(200);
    expect(db.prepare("SELECT material_id FROM project_material_table_provenance").all()).toEqual([{ material_id: second }]);
    db.prepare("DELETE FROM projects WHERE id = 1").run();
    expect(db.prepare("SELECT * FROM project_material_table_provenance").all()).toEqual([]);
  });
});
