import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { readContext, waitForJob } from "../../examples/mcp/helpers.mjs";

type Bag = Record<string, unknown>;
let directory: string, db: DatabaseSync, client: Client, server: import("@modelcontextprotocol/server").McpServer;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function call(name: string, args: Bag = {}): Promise<Bag> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify({ name, result: result.structuredContent })).not.toBe(true);
  return (result.structuredContent as { data: Bag }).data;
}
async function fails(name: string, args: Bag, code: string) {
  expect((await client.callTool({ name, arguments: args })).structuredContent).toMatchObject({ ok: false, error: { code } });
}
async function connect(allowlist: Set<string> | null = null, llmEnabled = false, timeoutMs = 30_000) {
  await client?.close(); await server?.close();
  server = (await import("./server")).createResumeLifeMcpServer({ allowlist, writeEnabled: true, llmEnabled, timeoutMs });
  client = new Client({ name: "file-import-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
}
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-file-import-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory); db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES(1,'本地项目','','')");
  await connect();
});
afterEach(async () => {
  await client?.close(); await server?.close(); await new Promise<void>(resolve => setImmediate(resolve)); db?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-file-import-test-")) throw new Error("Unsafe fixture cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
async function upload(bytes: Buffer, filename: string, purpose: string, idempotencyKey = "upload-fixture-file") {
  const request = { filename, purpose, byteLength: bytes.length, sha256: sha(bytes), idempotencyKey };
  const started = await call("begin_mcp_upload", request); expect(await call("begin_mcp_upload", request)).toEqual(started);
  for (let offset = 0; offset < bytes.length; offset += 49152) {
    const args = { uploadId: started.uploadId, offset, data: bytes.subarray(offset, offset + 49152).toString("base64") };
    const saved = await call("append_mcp_upload", args); expect(await call("append_mcp_upload", args)).toEqual(saved);
  }
  await connect(); const complete = await call("complete_mcp_upload", { uploadId: started.uploadId });
  expect(complete.status).toBe("complete"); expect(await call("complete_mcp_upload", { uploadId: started.uploadId })).toEqual(complete);
  return started.uploadId as string;
}
async function extract(bytes: Buffer, filename: string, purpose: string, prefix = "fixture") {
  const uploadId = await upload(bytes, filename, purpose, prefix + "-upload");
  const job = await call("start_mcp_job", { operation: "extract_uploaded_file", arguments: { uploadId, idempotencyKey: prefix + "-extract" } });
  const done = await waitForJob(call, job.jobId as string, { timeoutMs: 10000, intervalMs: 10 });
  expect(done.job.status, JSON.stringify(done)).toBe("succeeded");
  return prefix + "-extract";
}
async function proposal(source: Bag, result: Bag, key = "import-proposal-fixture") {
  const basis = await readContext(call, "get_file_import_context", { source });
  const input = { source, expectedRevision: basis.revision, result, idempotencyKey: key };
  const submitted = await call("submit_file_import", input); expect(await call("submit_file_import", input)).toEqual(submitted);
  const preview = await readContext(call, "preview_file_import", { proposalKey: key });
  return { preview, input: { proposalKey: key, kind: (source.target as Bag).kind, previewToken: preview.previewToken, idempotencyKey: key + "-save" } };
}
async function tableDocx() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>参与 SQLite 校验，尚未上线。</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  return zip.generateAsync({ type: "nodebuffer" });
}

it("uploads across reconnect, extracts in a persisted job and previews a normalized editable resume", async () => {
  const text = "姓名：示例人物\n参与 SQLite 开发，使用 Array<T> 和 &amp;。\n";
  const extractionKey = await extract(Buffer.from(text), "resume.txt", "resume");
  const document = await readContext(call, "get_file_extraction", { idempotencyKey: extractionKey }); expect(document.value.text).toBe(text);
  const { input, preview } = await proposal({ extractionKey, target: { kind: "resume" } }, { title: "文件导入", basic: { name: "示例人物" }, summary: { text: "参与 SQLite 开发，使用 Array<T> 和 &amp;。" } });
  expect(JSON.stringify(preview.value)).toContain("示例人物");
  const saved = await call("save_file_import", input); await connect(); expect(await call("save_file_import", input)).toEqual(saved);
  expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 1 });
  const web = await import("@/app/api/resumes/[id]/route");
  const response = await web.GET(new Request("http://localhost/api/resumes/" + saved.id), { params: Promise.resolve({ id: String(saved.id) }) });
  expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).toContain("示例人物");
  await fails("save_file_import", { ...input, kind: "project" }, "CONFLICT");
});

it("preserves native Word table provenance in project materials and Web reads", async () => {
  const extractionKey = await extract(await tableDocx(), "project.docx", "project");
  const extracted = await readContext(call, "get_file_extraction", { idempotencyKey: extractionKey });
  expect(extracted.value.tableDocument.segments.some((segment: { kind: string }) => segment.kind === "table-layout")).toBe(true);
  const source = { extractionKey, target: { kind: "project", projectId: 1 } };
  const { input } = await proposal(source, { title: "原始表格材料" });
  const saved = await call("save_file_import", input);
  const web = await import("@/app/api/projects/[id]/materials/[mid]/route");
  const response = await web.GET(new Request("http://localhost/api/projects/1/materials/" + saved.id), { params: Promise.resolve({ id: "1", mid: String(saved.id) }) });
  expect(await response.json()).toMatchObject({ content: extracted.value.text, tableProvenance: extracted.value.tableProvenance });
  const edited = await proposal(source, { title: "已编辑普通文本", content: "仅整理原文：参与校验，尚未上线。" }, "edited-file-proposal");
  const second = await call("save_file_import", edited.input);
  expect(db.prepare("SELECT 1 FROM project_material_table_provenance WHERE material_id=?").get(Number(second.id))).toBeUndefined();
  const basis = await readContext(call, "get_file_import_context", { source });
  await fails("submit_file_import", { source, expectedRevision: basis.revision, result: { title: "伪造来源", tableProvenance: extracted.value.tableProvenance }, idempotencyKey: "forged-table-source" }, "INVALID_ARGUMENT");
});

it("rejects out-of-order, mutated and oversized chunks, and mismatched final digests", async () => {
  const bytes = Buffer.from("完整文件");
  const created = await call("begin_mcp_upload", { filename: "valid.txt", purpose: "resume", byteLength: bytes.length, sha256: sha("different"), idempotencyKey: "invalid-upload-fixture" });
  await fails("append_mcp_upload", { uploadId: created.uploadId, offset: 1, data: bytes.toString("base64") }, "CONFLICT");
  await fails("append_mcp_upload", { uploadId: created.uploadId, offset: 0, data: "!!!!" }, "INVALID_ARGUMENT");
  await fails("append_mcp_upload", { uploadId: created.uploadId, offset: 0, data: Buffer.alloc(49153).toString("base64") }, "INVALID_ARGUMENT");
  await call("append_mcp_upload", { uploadId: created.uploadId, offset: 0, data: bytes.toString("base64") });
  await fails("append_mcp_upload", { uploadId: created.uploadId, offset: 0, data: Buffer.alloc(bytes.length).toString("base64") }, "CONFLICT");
  await fails("complete_mcp_upload", { uploadId: created.uploadId }, "CONFLICT");
  await fails("begin_mcp_upload", { filename: "../resume.txt", purpose: "resume", byteLength: 3, sha256: sha(bytes), idempotencyKey: "invalid-path-name" }, "INVALID_ARGUMENT");
});

it("keeps vision OCR disabled by default and explicitly selects local OCR independently of settings", async () => {
  const bytes = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#fff" } }).png().toBuffer();
  const uploadId = await upload(bytes, "scan.png", "resume");
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockResolvedValue("不应调用");
  const local = vi.spyOn(await import("@/lib/ocr-local"), "ocrPdfPagesLocally").mockResolvedValue("本地 OCR 识别姓名：示例人物");
  vi.spyOn(await import("@/lib/pdf-to-images"), "processImageBufferToPage").mockResolvedValue({ pageNumber: 1, buffer: bytes, base64: bytes.toString("base64"), width: 30, height: 30, hasVisualContent: true });
  vi.spyOn(await import("@/lib/settings"), "readSettings").mockReturnValue({ ocr_mode: "vision" } as ReturnType<typeof import("@/lib/settings").readSettings>);
  await fails("extract_uploaded_file", { uploadId, idempotencyKey: "disabled-ocr-test" }, "INVALID_ARGUMENT");
  await fails("extract_uploaded_file", { uploadId, ocrMode: "vision", idempotencyKey: "vision-blocked-test" }, "FORBIDDEN");
  await fails("start_mcp_job", { operation: "extract_uploaded_file", arguments: { uploadId, ocrMode: "vision", idempotencyKey: "vision-job-blocked" } }, "FORBIDDEN");
  expect(db.prepare("SELECT 1 FROM mcp_jobs WHERE request_key='vision-job-blocked'").get()).toBeUndefined();
  const args = { uploadId, ocrMode: "local", idempotencyKey: "local-ocr-test" }; await call("extract_uploaded_file", args);
  expect(local).toHaveBeenCalledTimes(1); expect(vision).not.toHaveBeenCalled();
  const result = await readContext(call, "get_file_extraction", { idempotencyKey: args.idempotencyKey });
  expect(result.value.ocr.engine).toBe("local");
});

async function visionFixture() {
  const bytes = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#fff" } }).png().toBuffer();
  const uploadId = await upload(bytes, "scan.png", "resume");
  vi.spyOn(await import("@/lib/pdf-to-images"), "processImageBufferToPage").mockResolvedValue({ pageNumber: 1, buffer: bytes, base64: bytes.toString("base64"), width: 30, height: 30, hasVisualContent: true });
  await connect(null, true);
  return { uploadId, ocrMode: "vision" as const, pdfMode: "auto" as const, idempotencyKey: "shared-vision-extraction" };
}

it("claims vision extraction before a job, synchronous retry and another process can duplicate the model call", async () => {
  const args = await visionFixture(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<string>();
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockImplementation(async () => { started.resolve(); return finish.promise; });
  const job = await call("start_mcp_job", { operation: "extract_uploaded_file", arguments: args });
  try {
    await started.promise;
    expect((await client.callTool({ name: "extract_uploaded_file", arguments: args })).structuredContent)
      .toMatchObject({ ok: false, error: { code: "BUSY", retryable: true } });
    await fails("get_file_extraction", { idempotencyKey: args.idempotencyKey }, "BUSY");
    await fails("extract_uploaded_file", { ...args, ocrMode: "off" }, "CONFLICT");
    const code = `const {extractUploadedFile}=require('./src/lib/mcp-file-import.ts'); extractUploadedFile(${JSON.stringify(args)},new AbortController().signal).then(()=>console.log('unexpected'),e=>console.log(e.code));`;
    const child = await promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", code], { cwd: process.cwd(), env: { ...process.env, RESUME_LIFE_DATA_DIR: directory }, windowsHide: true, timeout: 15_000 });
    expect(child.stdout.trim().split(/\r?\n/).at(-1)).toBe("BUSY");
  } finally { finish.resolve("只执行一次的 OCR 正文"); }
  const done = await waitForJob(call, job.jobId as string, { timeoutMs: 10000, intervalMs: 10 });
  expect(done.job.status).toBe("succeeded");
  expect(await call("extract_uploaded_file", args)).toEqual(done.result);
  expect(vision).toHaveBeenCalledTimes(1);
});

it.each(["configuration", "unauthorized", "rate-limit", "timeout", "file"])("preserves %s classification and never re-executes a failed extraction key", async kind => {
  const args = await visionFixture();
  const { LlmConfigError, LlmHttpError, LlmTimeoutError } = await import("@/lib/llm");
  const { FileFormatError } = await import("@/lib/parse-sandbox");
  const failures = {
    configuration: [new LlmConfigError("未配置模型"), "CONFIGURATION"],
    unauthorized: [new LlmHttpError(401, null), "CONFIGURATION"],
    "rate-limit": [new LlmHttpError(429, null), "BUSY"],
    timeout: [new LlmTimeoutError("模型超时"), "TIMEOUT"],
    file: [new FileFormatError("文件损坏"), "INVALID_ARGUMENT"],
  } as const;
  const [error, code] = failures[kind as keyof typeof failures];
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockRejectedValue(error);
  for (let i = 0; i < 2; i++) {
    expect((await client.callTool({ name: "extract_uploaded_file", arguments: args })).structuredContent)
      .toMatchObject({ ok: false, error: { code, retryable: false } });
  }
  await fails("get_file_extraction", { idempotencyKey: args.idempotencyKey }, code);
  await connect(null, true);
  await fails("extract_uploaded_file", args, code);
  expect(vision).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='extract_uploaded_file'").get()).toBeUndefined();
});

it("keeps a tombstone when a model result cannot commit or its attempt cache is cleared", async () => {
  const args = await visionFixture();
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockResolvedValue("已调用模型的正文");
  db.exec("CREATE TRIGGER fail_extraction BEFORE INSERT ON mcp_creation_receipts WHEN NEW.tool='extract_uploaded_file' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await fails("extract_uploaded_file", args, "INTERNAL");
  db.exec("DROP TRIGGER fail_extraction");
  await fails("extract_uploaded_file", args, "INTERNAL");
  db.exec("DELETE FROM mcp_operation_results WHERE tool='extract_uploaded_file:attempt'");
  await fails("extract_uploaded_file", args, "CONFLICT");
  expect(vision).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='extract_uploaded_file'").get()).toBeUndefined();
});

it("keeps the extraction key terminal after a request deadline", async () => {
  const args = await visionFixture();
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockImplementation(async (_pages, signal) => {
    await new Promise<void>(resolve => { if (signal!.aborted) resolve(); else signal!.addEventListener("abort", () => resolve(), { once: true }); });
    return "截止后才完成";
  });
  await connect(null, true, 100);
  expect((await client.callTool({ name: "extract_uploaded_file", arguments: args })).structuredContent)
    .toMatchObject({ ok: false, error: { code: "TIMEOUT", retryable: false } });
  await connect(null, true);
  await fails("extract_uploaded_file", args, "TIMEOUT");
  expect(vision).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='extract_uploaded_file'").get()).toBeUndefined();
});

it("lets a background job recover an extraction already running synchronously", async () => {
  const args = await visionFixture(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<string>();
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockImplementation(async () => { started.resolve(); return finish.promise; });
  const synchronous = call("extract_uploaded_file", args);
  await started.promise;
  const job = await call("start_mcp_job", { operation: "extract_uploaded_file", arguments: args });
  await new Promise(resolve => setTimeout(resolve, 30));
  finish.resolve("同步请求的唯一结果");
  const result = await synchronous;
  const done = await waitForJob(call, job.jobId as string, { timeoutMs: 10000, intervalMs: 10 });
  expect(done.job.status).toBe("succeeded"); expect(done.result).toEqual(result);
  expect(vision).toHaveBeenCalledTimes(1);
});

it.each(["timeout", "cancel"])("can %s a job waiting on a synchronous owner without cancelling that extraction", async mode => {
  const args = await visionFixture(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<string>();
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockImplementation(async () => { started.resolve(); return finish.promise; });
  const synchronous = call("extract_uploaded_file", args);
  await started.promise;
  try {
    const job = await call("start_mcp_job", { operation: "extract_uploaded_file", arguments: args, timeoutMs: mode === "timeout" ? 100 : 10_000 });
    if (mode === "cancel") await call("cancel_mcp_job", { jobId: job.jobId });
    const done = await waitForJob(call, job.jobId as string, { timeoutMs: 2000, intervalMs: 10 });
    expect(done.job).toMatchObject({ status: mode === "timeout" ? "failed" : "cancelled", errorCode: mode === "timeout" ? "TIMEOUT" : "CANCELLED" });
  } finally { finish.resolve("原始同步提取继续成功"); await synchronous; }
  expect(vision).toHaveBeenCalledTimes(1);
  expect((await readContext(call, "get_file_extraction", { idempotencyKey: args.idempotencyKey })).value.text).toBe("原始同步提取继续成功");
});

it("does not acquire an extraction again after its owner process exits", async () => {
  const args = await visionFixture(), { idempotencyKey, ...payload } = args;
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockResolvedValue("不应再次执行");
  const code = `const {claimFileExtraction}=require('./src/lib/mcp-file-extraction-state.ts'); claimFileExtraction(${JSON.stringify(idempotencyKey)},${JSON.stringify(payload)}); console.log('claimed');`;
  const child = await promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", code], { cwd: process.cwd(), env: { ...process.env, RESUME_LIFE_DATA_DIR: directory }, windowsHide: true, timeout: 15_000 });
  expect(child.stdout).toContain("claimed");
  await fails("extract_uploaded_file", args, "CONFLICT");
  await fails("get_file_extraction", { idempotencyKey }, "CONFLICT");
  expect(vision).not.toHaveBeenCalled();
});

it("rejects late extraction output after a data restore and keeps the old key invalid", async () => {
  const args = await visionFixture(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<string>();
  const vision = vi.spyOn(await import("@/lib/ocr-vision"), "ocrPdfPagesWithVision").mockImplementation(async () => { started.resolve(); return finish.promise; });
  const extracting = client.callTool({ name: "extract_uploaded_file", arguments: args });
  await started.promise;
  db.prepare("INSERT INTO runtime_state(id,data_generation) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation").run("restored-extraction");
  finish.resolve("旧数据返回的 OCR 正文");
  expect((await extracting).structuredContent).toMatchObject({ ok: false, error: { code: "CONFLICT", retryable: false } });
  await fails("extract_uploaded_file", args, "CONFLICT");
  expect(vision).toHaveBeenCalledTimes(1);
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='extract_uploaded_file'").get()).toBeUndefined();
});

it("rolls back formal import and receipt together and rejects changed project sources", async () => {
  const extractionKey = await extract(Buffer.from("参与数据库维护"), "material.md", "project");
  const source = { extractionKey, target: { kind: "project", projectId: 1 } };
  const prepared = await proposal(source, { title: "事实材料" });
  db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON project_materials BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await fails("save_file_import", prepared.input, "INTERNAL");
  expect(db.prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='save_file_import'").get()).toBeUndefined();
  db.exec("DROP TRIGGER fail_import; UPDATE projects SET name='已修改项目' WHERE id=1");
  await fails("save_file_import", prepared.input, "CONFLICT");
  expect(db.prepare("SELECT COUNT(*) n FROM project_materials").get()).toEqual({ n: 0 });
  const refreshed = await proposal(source, { title: "事实材料" }, "refreshed-import-proposal"); await call("save_file_import", refreshed.input);
});

it("cleans expired temporary upload bytes while retaining save tombstones and formal records", async () => {
  const extractionKey = await extract(Buffer.from("姓名：示例人物"), "resume.md", "resume");
  const prepared = await proposal({ extractionKey, target: { kind: "resume" } }, { basic: { name: "示例人物" } });
  const saved = await call("save_file_import", prepared.input);
  db.exec("UPDATE mcp_creation_receipts SET created_at='2000-01-01'; UPDATE mcp_uploads SET created_at='2000-01-01'; UPDATE mcp_jobs SET updated_at='2000-01-01'");
  const preview = await call("preview_mcp_cache_cleanup"); await call("cleanup_mcp_cache", { previewToken: preview.previewToken });
  expect(db.prepare("SELECT COUNT(*) n FROM mcp_upload_chunks").get()).toEqual({ n: 0 });
  expect(await call("save_file_import", prepared.input)).toEqual(saved);
  await fails("get_file_extraction", { idempotencyKey: extractionKey }, "NOT_FOUND");
  expect(db.prepare("SELECT COUNT(*) n FROM resumes").get()).toEqual({ n: 1 });
});
