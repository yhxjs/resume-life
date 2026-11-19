import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractContentFromFile } from "@/lib/parse-file";

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const shape = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape";
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
function textbox(content: string, anchor = "inline", prefix = "wps") {
  return `<w:drawing><wp:${anchor}><a:graphic><a:graphicData uri="${shape}"><${prefix}:wsp xmlns:${prefix}="${shape}"><${prefix}:txbx><w:txbxContent>${content}</w:txbxContent></${prefix}:txbx></${prefix}:wsp></a:graphicData></a:graphic></wp:${anchor}></w:drawing>`;
}
function drawing(content: string) {
  return `<w:drawing><wp:inline><a:graphic><a:graphicData uri="${shape}">${content}</a:graphicData></a:graphic></wp:inline></w:drawing>`;
}
function shapeTextbox(content: string) {
  return `<wps:wsp><wps:txbx><w:txbxContent>${content}</w:txbxContent></wps:txbx></wps:wsp>`;
}
function vml(content: string) {
  return `<w:pict><v:shape><v:textbox><w:txbxContent>${content}</w:txbxContent></v:textbox></v:shape></w:pict>`;
}
async function makeDocx(body: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="${word}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wps="${shape}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

describe("DOCX visible textboxes", () => {
  const limited = paragraph("Only tested locally, not deployed; benefit unverified.");
  it.each(["inline", "anchor"])("retains a modern %s textbox after its anchoring paragraph", async anchor => {
    const file = await makeDocx(`<w:p><w:r><w:t>Project A.</w:t>${textbox(limited, anchor, "custom")}</w:r></w:p>${paragraph("Project B.")}`);
    await expect(extractContentFromFile("textbox.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A.\n\nOnly tested locally, not deployed; benefit unverified.\n\nProject B.\n\n" });
  });

  it("keeps VML textbox content separated from surrounding facts", async () => {
    const file = await makeDocx(`<w:p><w:r><w:t>Project A.</w:t>${vml(limited)}</w:r></w:p>`);
    await expect(extractContentFromFile("vml.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A.\n\nOnly tested locally, not deployed; benefit unverified.\n\n" });
  });

  it("selects a supported modern text choice once instead of its stale VML fallback", async () => {
    const alternatives = `<mc:AlternateContent><mc:Choice Requires="wps">${textbox(limited)}</mc:Choice><mc:Fallback>${vml(paragraph("STALE alternate copy"))}</mc:Fallback></mc:AlternateContent>`;
    const file = await makeDocx(`<w:p><w:r>${alternatives}</w:r></w:p>`);
    await expect(extractContentFromFile("alternate.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "\n\nOnly tested locally, not deployed; benefit unverified.\n\n" });
  });

  it("uses the fallback when a choice requires an unsupported namespace", async () => {
    const alternatives = `<mc:AlternateContent xmlns:unknown="urn:unsupported"><mc:Choice Requires="wps unknown">${textbox(paragraph("UNSUPPORTED choice"))}</mc:Choice><mc:Fallback>${vml(limited)}</mc:Fallback></mc:AlternateContent>`;
    const file = await makeDocx(`<w:p><w:r>${alternatives}</w:r></w:p>`);
    await expect(extractContentFromFile("fallback.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "\n\nOnly tested locally, not deployed; benefit unverified.\n\n" });
  });

  it("excludes an unsupported choice nested inside a drawing before reading its fallback textbox", async () => {
    const alternatives = `<mc:AlternateContent xmlns:unknown="urn:unsupported"><mc:Choice Requires="unknown">${shapeTextbox(paragraph("HIDDEN: led launch and achieved 50%"))}</mc:Choice><mc:Fallback>${shapeTextbox(limited)}</mc:Fallback></mc:AlternateContent>`;
    const file = await makeDocx(`<w:p><w:r><w:t>Project A.</w:t>${drawing(alternatives)}</w:r></w:p>`);
    await expect(extractContentFromFile("nested-alternate.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A.\n\nOnly tested locally, not deployed; benefit unverified.\n\n" });
  });

  it("selects the first compatible choice even when it has no textbox", async () => {
    const emptyShape = drawing("<wps:wsp><wps:cNvSpPr/><wps:spPr/></wps:wsp>");
    const alternatives = `<mc:AlternateContent><mc:Choice Requires="wps">${emptyShape}</mc:Choice><mc:Choice Requires="wps">${textbox(paragraph("HIDDEN: second compatible choice"))}</mc:Choice><mc:Fallback>${vml(paragraph("HIDDEN: fallback"))}</mc:Fallback></mc:AlternateContent>`;
    const file = await makeDocx(`<w:p><w:r><w:t>Project A.</w:t>${alternatives}</w:r></w:p>`);
    await expect(extractContentFromFile("first-compatible-choice.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A.\n\n" });
  });

  it("emits no alternate text when no choice is compatible and no fallback exists", async () => {
    const alternatives = `<mc:AlternateContent xmlns:unknown="urn:unsupported"><mc:Choice Requires="unknown">${shapeTextbox(paragraph("HIDDEN: unsupported choice without fallback"))}</mc:Choice></mc:AlternateContent>`;
    const file = await makeDocx(`<w:p><w:r><w:t>Project A.</w:t>${drawing(alternatives)}</w:r></w:p>`);
    await expect(extractContentFromFile("unsupported-no-fallback.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A.\n\n" });
  });

  it("reads supported modern choices without a fallback and preserves nested table/line content", async () => {
    const content = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t><![CDATA[Array<T>]]></w:t><w:cr/><w:t>not deployed</w:t></w:r></w:p></w:tc><w:tc>' + paragraph("2024") + '</w:tc></w:tr></w:tbl>';
    const alternatives = `<mc:AlternateContent><mc:Choice Requires="wps">${textbox(content)}</mc:Choice></mc:AlternateContent>`;
    const file = await makeDocx(`<w:p><w:r>${alternatives}</w:r></w:p>`);
    await expect(extractContentFromFile("no-fallback.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "\n\n[表格]\n\n[第 1 行]\n\n[第 1 行，第 1 列]\n\nArray<T>\nnot deployed\n\n[第 1 行，第 2 列]\n\n2024\n\n[表格结束]\n\n" });
  });

  it("does not read arbitrary Word-looking content inside an unrelated drawing namespace", async () => {
    const content = textbox(paragraph("UNRELATED hidden text")).replaceAll(shape, "urn:unrelated");
    const file = await makeDocx(`<w:p><w:r><w:t>Visible body.</w:t>${content}</w:r></w:p>`);
    await expect(extractContentFromFile("unrelated.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Visible body.\n\n" });
  });
});
