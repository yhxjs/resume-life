import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import JSZip from "jszip";
import { readContext, readArtifact } from "../../examples/mcp/helpers.mjs";

type Bag = Record<string, unknown>;
let directory: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer;
async function call(name: string, args: Bag = {}): Promise<Bag> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify({ name, result: result.structuredContent })).not.toBe(true);
  return (result.structuredContent as { data: Bag }).data;
}
async function fails(name: string, args: Bag, code: string) {
  expect((await client.callTool({ name, arguments: args })).structuredContent).toMatchObject({ ok: false, error: { code } });
}
async function connect(allowlist: Set<string> | null = null, writeEnabled = true) {
  await client?.close(); await server?.close();
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist, writeEnabled, llmEnabled: false, timeoutMs: 30_000 });
  client = new Client({ name: "template-avatar-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-template-avatar-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory); db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes(id,title,created_at,updated_at) VALUES(1,'公开简历','','');");
  const { normalizeContent } = await import("@/lib/modules");
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'basic','basic','基本信息',0,?,'')")
    .run(JSON.stringify(normalizeContent("basic", { name: "示例人物", phone: "13800138000", email: "sample@example.com", location: "香港" })));
  db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,sort,content,updated_at) VALUES(1,'summary','summary','自我评价',1,?,'')")
    .run(JSON.stringify(normalizeContent("summary", { text: "参与 SQLite 数据工具维护。" })));
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-template-avatar-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
async function createTemplate(templateRef = "classic", key = "create-template-fixture") {
  return call("create_resume_template", { name: "测试模板", templateRef,
    expectedRevision: (await readContext(call, "get_resume_template_context")).revision, idempotencyKey: key });
}
async function templateEdit(templateId: number, patch: Bag) {
  const proposal = { templateId, ...patch, expectedRevision: (await readContext(call, "get_resume_template_context", { templateId })).revision };
  const preview = await readContext(call, "preview_resume_template", proposal, true);
  return { preview, input: { ...proposal, previewToken: preview.previewToken, idempotencyKey: "edit-template-fixture" } };
}
async function upload(bytes: Buffer, key: string, purpose = "avatar") {
  const started = await call("begin_mcp_upload", { filename: "photo.png", purpose, byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), idempotencyKey: key });
  await call("append_mcp_upload", { uploadId: started.uploadId, offset: 0, data: bytes.toString("base64") });
  await call("complete_mcp_upload", { uploadId: started.uploadId }); return started.uploadId;
}
async function avatarRequest(uploadId: unknown, key: string) {
  return { resumeId: 1, moduleKey: "basic", uploadId, idempotencyKey: key,
    expectedRevision: (await readContext(call, "get_resume_avatar_context", { resumeId: 1 })).revision };
}
async function webResume() {
  const route = await import("@/app/api/resumes/[id]/route");
  const response = await route.GET(new Request("http://localhost/api/resumes/1"), { params: Promise.resolve({ id: "1" }) });
  expect(response.status).toBe(200); return response.json();
}

it("creates, copies and edits a template with affected drafts, frozen publication and matching Web/export style", async () => {
  const created = await createTemplate();
  const copy = await createTemplate("custom:" + created.id, "copy-template-fixture");
  expect(copy.id).not.toBe(created.id);
  db.prepare("UPDATE resumes SET template=? WHERE id=1").run("custom:" + created.id);
  const { publishResumeVersion, getResumeVersion } = await import("@/lib/resume-versions");
  const version = publishResumeVersion(1, { name: "原始样式" });
  const frozen = getResumeVersion(1, version.id)!.snapshot;
  const { preview, input } = await templateEdit(Number(created.id), { name: "修改名称", style: { accent: "#115599" } });
  expect(preview.value.affectedDrafts).toMatchObject([{ id: 1, after: { accent: "#115599" } }]);
  expect(preview.value.before.name).toBe("测试模板");
  await call("save_resume_template", input); await connect(); expect(await call("save_resume_template", input)).toEqual({ id: created.id });
  const route = await import("@/app/api/templates/route");
  expect(await (await route.GET(new Request("http://localhost/api/templates"))).json())
    .toMatchObject({ items: [{ id: created.id, name: "修改名称", style: { accent: "#115599" } }, { id: copy.id, name: "测试模板" }] });
  expect((await webResume()).resume.template).toBe("custom:" + created.id);
  const current = await readContext(call, "get_resume_export_context", { source: { resumeId: 1 } });
  expect(current.value.output.resume.resolved_style).toMatchObject({ accent: "#115599" });
  const old = await readContext(call, "get_resume_export_context", { source: { resumeId: 1, versionId: version.id } });
  expect(old.value.output.resume.resolved_style).toEqual(frozen.resolved_style);
  expect(getResumeVersion(1, version.id)!.snapshot).toEqual(frozen);
});

it("rejects stale template membership and mutated previews, then rolls back template and receipt on failure", async () => {
  const created = await createTemplate(); db.prepare("UPDATE resumes SET template=? WHERE id=1").run("custom:" + created.id);
  const { input } = await templateEdit(Number(created.id), { name: "新名称" });
  await fails("save_resume_template", { ...input, name: "篡改名称" }, "CONFLICT");
  db.prepare("INSERT INTO resumes(id,title,template,created_at,updated_at) VALUES(2,'新增引用',?,'','')").run("custom:" + created.id);
  await fails("save_resume_template", input, "CONFLICT");
  const fresh = (await templateEdit(Number(created.id), { name: "新名称" })).input;
  db.exec("CREATE TRIGGER fail_template BEFORE UPDATE ON resume_templates BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await fails("save_resume_template", fresh, "INTERNAL");
  expect(db.prepare("SELECT name FROM resume_templates WHERE id=?").get(Number(created.id))).toEqual({ name: "测试模板" });
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='save_resume_template'").get()).toBeUndefined();
  db.exec("DROP TRIGGER fail_template"); await call("save_resume_template", fresh);
});

it("marks a corrupted template in preview, permits explicit repair and rejects malformed draft overrides", async () => {
  db.exec("INSERT INTO resume_templates(id,name,style,created_at,updated_at) VALUES(1,'损坏模板','null','',''); UPDATE resumes SET template='custom:1'");
  const { preview, input } = await templateEdit(1, { style: {} });
  expect(preview.value.before.corrupted).toBe(true);
  expect(preview.value.affectedDrafts[0].beforeCorrupted).toBe(true);
  expect(preview.value.after.corrupted).toBe(false); await call("save_resume_template", input);
  db.exec("UPDATE resumes SET style_overrides='[]' WHERE id=1");
  const basis = await readContext(call, "get_resume_template_context", { templateId: 1 });
  await fails("preview_resume_template", { templateId: 1, expectedRevision: basis.revision, name: "改名" }, "INVALID_ARGUMENT");
});

it("normalizes real images, replaces the draft avatar and preserves the published image in exported documents", async () => {
  const bytes = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#993366" } }).png().toBuffer();
  const input = await avatarRequest(await upload(bytes, "upload-first-avatar"), "set-first-avatar");
  await call("set_resume_avatar", input); await connect(); await call("set_resume_avatar", input);
  const current = await webResume(), firstUrl = current.modules.find((m: { type: string }) => m.type === "basic").content.avatar;
  const storage = await import("@/lib/upload-storage"), first = storage.readUploadFile(path.basename(firstUrl))!;
  const dimensions = await sharp(first.bytes).metadata(); expect(dimensions.width).toBe(600); expect(dimensions.height).toBe(450);
  const { publishResumeVersion, getResumeVersion } = await import("@/lib/resume-versions");
  const version = publishResumeVersion(1, { name: "原始头像" });
  const second = await sharp({ create: { width: 100, height: 150, channels: 3, background: "#334499" } }).png().toBuffer();
  const replace = await avatarRequest(await upload(second, "upload-second-avatar"), "replace-avatar-fixture");
  await call("set_resume_avatar", replace);
  const after = await webResume(), secondUrl = after.modules.find((m: { type: string }) => m.type === "basic").content.avatar;
  expect(secondUrl).not.toBe(firstUrl); expect(storage.readUploadFile(path.basename(firstUrl))).not.toBeNull();
  expect(getResumeVersion(1, version.id)!.snapshot.modules.find(m => m.type === "basic")!.content).toMatchObject({ avatar: firstUrl });
  const source = { resumeId: 1, versionId: version.id }, basis = await readContext(call, "get_resume_export_context", { source });
  expect(basis.value.canExport).toBe(true);
  expect(basis.value.avatarSha256).toBe(createHash("sha256").update(first.bytes).digest("hex"));
  const artifact = await call("export_resume", { source, format: "docx", expectedRevision: basis.revision, idempotencyKey: "avatar-docx-export" });
  const zip = await JSZip.loadAsync(await readArtifact(call, artifact));
  const media = Object.values(zip.files).filter(file => file.name.startsWith("word/media/") && !file.dir);
  expect(media).toHaveLength(1);
  // DOCX resizes/crops the image. Its central pixel must remain the old purple, not the replacement blue.
  const pixels = await sharp(await media[0]!.async("nodebuffer")).raw().toBuffer({ resolveWithObject: true });
  const center = (Math.floor(pixels.info.height / 2) * pixels.info.width + Math.floor(pixels.info.width / 2)) * pixels.info.channels;
  expect([...pixels.data.subarray(center, center + 3)]).toEqual([153, 51, 102]);
  await call("set_resume_avatar", await avatarRequest(null, "clear-avatar-fixture"));
  expect(storage.readUploadFile(path.basename(secondUrl))).toBeNull();
  expect(storage.readUploadFile(path.basename(firstUrl))).not.toBeNull();
});

it("rejects wrong-purpose images and invalid bytes and cleans uncommitted normalized files on a failed write", async () => {
  const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#000000" } }).png().toBuffer();
  const wrong = await avatarRequest(await upload(bytes, "wrong-purpose-upload", "resume"), "wrong-purpose-avatar");
  await fails("set_resume_avatar", wrong, "INVALID_ARGUMENT");
  const invalid = await avatarRequest(await upload(Buffer.from("this is not an actual png"), "invalid-upload"), "invalid-avatar");
  await fails("set_resume_avatar", invalid, "INVALID_ARGUMENT");
  const input = await avatarRequest(await upload(bytes, "valid-upload"), "rollback-avatar");
  db.exec("CREATE TRIGGER fail_avatar BEFORE UPDATE OF content ON resume_modules BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await fails("set_resume_avatar", input, "INTERNAL");
  expect(fs.readdirSync(path.join(directory, "uploads"))).toEqual([]);
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='set_resume_avatar'").get()).toBeUndefined();
  db.exec("DROP TRIGGER fail_avatar");
  db.exec("UPDATE resumes SET title='发生并发修改' WHERE id=1");
  await fails("set_resume_avatar", input, "CONFLICT");
  await call("set_resume_avatar", await avatarRequest(input.uploadId, "rollback-avatar"));
});

it("enforces source read permissions and write switches for templates and avatars", async () => {
  const basis = await readContext(call, "get_resume_template_context");
  const args = { name: "受限模板", style: {}, expectedRevision: basis.revision, idempotencyKey: "restricted-template" };
  await connect(new Set(["get_resume_template_context", "create_resume_template"]));
  await fails("create_resume_template", args, "FORBIDDEN");
  await connect(new Set(["get_resume_template_context", "create_resume_template", "get_resume"]));
  await call("create_resume_template", args);
  await connect();
  const avatar = await avatarRequest(null, "restricted-avatar");
  await connect(new Set(["get_resume", "set_resume_avatar"]));
  await fails("set_resume_avatar", avatar, "FORBIDDEN");
  await connect(null, false); await fails("create_resume_template", args, "FORBIDDEN");
  await fails("set_resume_avatar", avatar, "FORBIDDEN");
});
