import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

const { safeChat } = vi.hoisted(() => ({ safeChat: vi.fn() }));
vi.mock("@/lib/safe-llm", () => ({
  safeChat,
  LLM_FEATURES: { resumeImportParse: "resumeImportParse" },
}));

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relationship = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationship = "http://schemas.openxmlformats.org/package/2006/relationships";
const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (body: string, properties = "") => `<w:tc><w:tcPr>${properties}</w:tcPr>${body}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const table = (...rows: string[]) => `<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>${rows.join("")}</w:tbl>`;
const emptyTable = table(row(cell(paragraph("")), cell(paragraph(""))));
const noteReference = (kind = "footnote", id = "1") => `<w:p><w:r><w:${kind}Reference w:id="${id}"/></w:r></w:p>`;
const hiddenParagraph = '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏旧事实</w:t></w:r></w:p>';
const prefix = "resume-life-docx-empty-";
let directory: string, token: string, db: DatabaseSync;
const POST = async (request: Request) => (await import("@/app/api/import/parse/route")).POST(request);
const extractContentFromFile = async (name: string, buffer: Buffer) => (await import("@/lib/parse-file")).extractContentFromFile(name, buffer);

type Parts = {
  header?: string;
  footer?: string;
  footnote?: string;
  endnote?: string;
};

async function makeDocx(body: string, parts: Parts = {}) {
  const zip = new JSZip();
  const partNames = Object.keys(parts) as (keyof Parts)[];
  const filename = (kind: keyof Parts) => `${kind}${kind.endsWith("note") ? "s" : ""}.xml`;
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${partNames.map(kind => `<Override PartName="/word/${filename(kind)}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${filename(kind).slice(0, -4)}+xml"/>`).join("")}</Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${packageRelationship}"><Relationship Id="main" Type="${relationship}/officeDocument" Target="word/document.xml"/></Relationships>`);
  const references = (["header", "footer"] as const).filter(kind => parts[kind] !== undefined)
    .map(kind => `<w:${kind}Reference w:type="default" r:id="${kind}"/>`).join("");
  zip.file("word/document.xml", Buffer.from(`<w:document xmlns:w="${word}" xmlns:r="${relationship}"><w:body>${body}<w:sectPr>${references}</w:sectPr></w:body></w:document>`));
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${packageRelationship}">${partNames.map(kind => `<Relationship Id="${kind}" Type="${relationship}/${filename(kind).slice(0, -4)}" Target="${filename(kind)}"/>`).join("")}</Relationships>`);
  for (const kind of partNames) {
    const root = kind === "header" ? "hdr" : kind === "footer" ? "ftr" : `${kind}s`;
    const content = kind.endsWith("note") ? `<w:${kind} w:id="1">${parts[kind]}</w:${kind}>` : parts[kind];
    zip.file(`word/${filename(kind)}`, Buffer.from(`<w:${root} xmlns:w="${word}">${content}</w:${root}>`));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

function upload(file: Buffer, extractOnly: boolean) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(file)], "source.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }));
  if (extractOnly) form.append("extractOnly", "true");
  return new Request("http://localhost/api/import/parse", { method: "POST", headers: { cookie: `resume_life_session=${token}` }, body: form });
}

describe("DOCX empty content does not become resume material", () => {
  beforeEach(async () => {
    vi.resetModules();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
    db = (await import("@/lib/db")).getDb();
    token = (await import("@/lib/auth")).createSession().token;
    safeChat.mockReset();
    safeChat.mockRejectedValue(new Error("Unexpected model call for an empty document"));
  });
  afterEach(() => {
    db?.close();
    vi.unstubAllEnvs();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(prefix)) throw new Error("Unsafe test cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each<{ name: string; body: string; parts?: Parts }>([
    { name: "empty cells", body: emptyTable },
    { name: "whitespace cells", body: table(row(cell(paragraph(" \t ")), cell(paragraph("　")))) },
    { name: "deleted rows", body: table(row("<w:trPr><w:del/></w:trPr>", cell(paragraph("已删除事实")))) },
    { name: "hidden text", body: table(row(cell(hiddenParagraph))) },
    { name: "nested empty table", body: table(row(cell(emptyTable + paragraph("")))) },
    { name: "horizontal continuation text", body: table(row(cell(paragraph(""), '<w:hMerge w:val="restart"/>'), cell(paragraph("续格中未显示的文字"), "<w:hMerge/>"))) },
    { name: "vertical continuation text", body: table(row(cell(paragraph(""), '<w:vMerge w:val="restart"/>')), row(cell(paragraph("续格中未显示的文字"), "<w:vMerge/>"))) },
    { name: "empty header and footer", body: paragraph(""), parts: { header: emptyTable, footer: paragraph(" \t ") } },
    { name: "empty referenced footnote", body: noteReference(), parts: { footnote: paragraph("") } },
    { name: "empty referenced endnote", body: noteReference("endnote"), parts: { endnote: paragraph("") } },
    { name: "empty table in referenced footnote", body: noteReference(), parts: { footnote: emptyTable } },
    { name: "empty note cycle", body: noteReference(), parts: { footnote: noteReference("endnote"), endnote: noteReference() } },
    { name: "unreferenced note text", body: emptyTable, parts: { footnote: paragraph("未引用的旧事实") } },
  ])("rejects $name before either import mode can call the model", async ({ body, parts }) => {
    const file = await makeDocx(body, parts);
    const extracted = await extractContentFromFile("empty.docx", file);
    expect.soft(extracted.text.trim()).toBe("");
    expect(extracted.tableProvenance?.markers).toEqual([]);
    for (const extractOnly of [true, false]) {
      const response = await POST(upload(file, extractOnly));
      expect.soft(response.status).toBe(400);
      expect.soft(await response.json()).toMatchObject({ error: "没有提取到文本内容" });
    }
    expect(safeChat).not.toHaveBeenCalled();
  });

  it.each(["[表格]", "[页眉：第 1 节默认]"])("keeps the user's literal %s as real content", async literal => {
    const file = await makeDocx(paragraph(literal));
    await expect(extractContentFromFile("literal.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: `${literal}\n\n` });
    const response = await POST(upload(file, true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ extractedText: `${literal}\n\n`, sourceReceipt: {
      version: 1, id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(Number),
    } });
    expect(safeChat).not.toHaveBeenCalled();
  });

  it.each(["header", "footer", "footnote", "endnote"] as const)("accepts real text found only in a referenced %s", async kind => {
    const qualification = "仅测试，未上线；收益未验证。";
    const file = await makeDocx(kind.endsWith("note") ? noteReference(kind) : paragraph(""), {
      [kind]: paragraph(qualification),
    });
    const extracted = await extractContentFromFile("only-part.docx", file);
    expect(extracted.text).toContain(qualification);
    expect(extracted.tableProvenance?.markers).toEqual([]);
    const response = await POST(upload(file, true));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ extractedText: extracted.text, sourceReceipt: {
      version: 1, id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(Number),
    } });
    expect(safeChat).not.toHaveBeenCalled();
  });

  it("still counts table structure in the combined character budget", async () => {
    const file = await makeDocx(table(row(cell(paragraph("😀".repeat(199_999))))));
    await expect(extractContentFromFile("over-limit.docx", file)).rejects.toThrow("200000");
  });
});
