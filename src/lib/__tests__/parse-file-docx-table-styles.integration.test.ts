import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import observations from "./fixtures/docx-table-style-visibility.json";

const { safeChat } = vi.hoisted(() => ({ safeChat: vi.fn() }));
vi.mock("@/lib/safe-llm", () => ({ safeChat, LLM_FEATURES: { resumeImportParse: "resumeImportParse" } }));
const prefix = "resume-life-docx-style-";
let directory: string, token: string, db: DatabaseSync;
const POST = async (request: Request) => (await import("@/app/api/import/parse/route")).POST(request);
const extractContentFromFile = async (name: string, buffer: Buffer) => (await import("@/lib/parse-file")).extractContentFromFile(name, buffer);
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  token = (await import("@/lib/auth")).createSession().token;
  safeChat.mockReset();
  safeChat.mockRejectedValue(new Error("Synthetic model error"));
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(prefix)) throw new Error("Unsafe test cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function archive(parts: Record<string, string | undefined>) {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(parts)) if (xml !== undefined) zip.file(name, Buffer.from(xml));
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
function upload(file: Buffer, extractOnly: boolean) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(file)], "table.docx"));
  if (extractOnly) form.append("extractOnly", "true");
  return new Request("http://localhost/api/import/parse", { method: "POST", headers: { cookie: `resume_life_session=${token}` }, body: form });
}
const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
function example(body: string, extraStyles = "") {
  const fixture = observations.cases.find(item => item.name === "first-row")!;
  return {
    ...fixture.parts,
    "word/document.xml": `<w:document xmlns:w="${word}"><w:body>${body}</w:body></w:document>`,
    "word/styles.xml": fixture.parts["word/styles.xml"].replace("</w:styles>", `${extraStyles}</w:styles>`),
  };
}
const paragraph = (text: string, props = "") => `<w:p><w:r><w:rPr>${props}</w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const table = (text: string, props = "", style = "T") => `<w:tbl><w:tblPr><w:tblStyle w:val="${style}"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc>${paragraph(text, props)}</w:tc></w:tr></w:tbl>`;

// These source strings were checked against independently rendered Word pages.
// Reconstructing the ZIP here exercises the real parser, not a style resolver mock.
it.each(observations.cases)("preserves Word table-style visibility: $name", async fixture => {
  const file = await archive(fixture.parts);
  const { text } = await extractContentFromFile("table-style.docx", file);
  for (const value of fixture.visible) expect.soft(text).toContain(value);
  for (const value of fixture.hidden) expect.soft(text).not.toContain(value);
});

it("rejects an all-hidden table before either import mode can call the model", async () => {
  const file = await archive(example(table("主导上线，收益50%")));
  await expect(extractContentFromFile("hidden.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "" });
  for (const extractOnly of [true, false]) {
    const response = await POST(upload(file, extractOnly));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "没有提取到文本内容" });
  }
  expect(safeChat).not.toHaveBeenCalled();
});

it("sends only visible table source and generated geometry to the model as untrusted material", async () => {
  const file = await archive(example(table("主导上线，收益50%") + paragraph("仅测试，未上线。")));
  const response = await POST(upload(file, false));
  expect(response.status).toBe(502);
  const body = await response.json();
  expect(body.extractedText).toContain("仅测试，未上线。");
  expect(body.extractedText).not.toContain("主导上线");
  expect(body.extractedText).toContain("[表格]");
  expect(safeChat).toHaveBeenCalledOnce();
  const part = safeChat.mock.calls[0]?.[3][0].parts[1];
  expect(part).toMatchObject({ trust: "untrusted", tag: "resume_source" });
  const source = JSON.parse(part.text).tableDocument;
  expect(source).toMatchObject({ version: 1, format: "docx" });
  expect(source.segments.map((segment: { text: string }) => segment.text).join("")).toBe(body.extractedText);
  expect(source.segments.filter((segment: { kind: string }) => segment.kind === "table-layout")).toHaveLength(4);
  expect(body.sourceReceipt).toMatchObject({ version: 1, id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
});

it("keeps a direct false override in a hidden table with Strict Word namespaces", async () => {
  const parts = example(table("Visible direct override", '<w:vanish w:val="false"/>'));
  for (const [name, value] of Object.entries(parts)) if (value !== undefined) Object.assign(parts, { [name]: value.replaceAll(word, "http://purl.oclc.org/ooxml/wordprocessingml/main") });
  const { text } = await extractContentFromFile("strict.docx", await archive(parts));
  expect(text).toContain("[第 1 行，第 1 列]\n\nVisible direct override");
});

it("applies table hiding to referenced footnotes while ignoring a bad style in an unreferenced note", async () => {
  const body = '<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p>';
  const cycle = '<w:style w:type="table" w:styleId="Cycle"><w:basedOn w:val="Cycle"/></w:style>';
  const parts: Record<string, string | undefined> = example(body, cycle);
  parts["word/footnotes.xml"] = `<w:footnotes xmlns:w="${word}"><w:footnote w:id="1">${table("Hidden note")}${paragraph("Visible note")}</w:footnote><w:footnote w:id="2">${table("unused", "", "Cycle")}</w:footnote></w:footnotes>`;
  const { text } = await extractContentFromFile("notes.docx", await archive(parts));
  expect(text).toContain("Visible note");
  expect(text).not.toContain("Hidden note");
  expect(text).not.toContain("unused");
  parts["word/document.xml"] = parts["word/document.xml"]!.replace('w:id="1"', 'w:id="2"');
  await expect(extractContentFromFile("bad-note.docx", await archive(parts))).rejects.toThrow();
});

it.each([
  ["table", "noHBand", "bogus"],
  ["table", "noVBand", ""],
  ["style", "firstRow", ""],
  ["style", "firstColumn", "bogus"],
  ["row", "lastRow", ""],
  ["row", "lastColumn", "bogus"],
])("rejects invalid table look at %s: %s=%s before model use", async (location, attribute, value) => {
  const look = `<w:tblLook w:${attribute}="${value}"/>`;
  let body = table("Uncertain source", "", location === "style" ? "Bad" : "T");
  if (location === "table") body = body.replace("</w:tblPr>", `${look}</w:tblPr>`);
  if (location === "row") body = body.replace("<w:tr>", `<w:tr><w:tblPrEx>${look}</w:tblPrEx>`);
  const style = location === "style"
    ? `<w:style w:type="table" w:styleId="Bad"><w:basedOn w:val="T"/><w:tblPr>${look}</w:tblPr></w:style>`
    : "";
  const file = await archive(example(body, style));
  for (const extractOnly of [true, false]) {
    const response = await POST(upload(file, extractOnly));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "文件内容无法解析，请确认文件格式正确" });
  }
  expect(safeChat).not.toHaveBeenCalled();
});
