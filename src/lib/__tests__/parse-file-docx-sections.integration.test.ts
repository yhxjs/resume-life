import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractContentFromFile } from "@/lib/parse-file";
import { FileFormatError } from "@/lib/parse-sandbox";

const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const reference = (kind: string, id: string, type = "default") => `<w:${kind}Reference w:type="${type}" r:id="${id}"/>`;
type Part = { id: string; kind: "header" | "footer"; body: string; target?: string; external?: boolean };
async function makeDocx(body: string, parts: Part[], settings = "", extra: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="${w}" xmlns:r="${r}"><w:body>${body}</w:body></w:document>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${rel}">${parts.map(part => `<Relationship Id="${part.id}" Type="${r}/${part.kind}" Target="${part.target ?? `${part.id}.xml`}"${part.external ? ' TargetMode="External"' : ""}/>`).join("")}${settings ? `<Relationship Id="settings" Type="${r}/settings" Target="settings.xml"/>` : ""}</Relationships>`);
  // Buffer avoids JSZip splitting a supplementary character across UTF-16 string chunks.
  for (const part of parts) if (!part.external) zip.file(`word/${part.target ?? `${part.id}.xml`}`, Buffer.from(`<w:${part.kind === "header" ? "hdr" : "ftr"} xmlns:w="${w}" xmlns:r="${r}">${part.body}</w:${part.kind === "header" ? "hdr" : "ftr"}>`));
  if (settings) zip.file("word/settings.xml", `<w:settings xmlns:w="${w}">${settings}</w:settings>`);
  for (const [path, text] of Object.entries(extra)) zip.file(path, text);
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

describe("DOCX section headers and footers", () => {
  it("retains referenced contact details and qualifications without reading an unreferenced part", async () => {
    const file = await makeDocx(p("Project A: parameter checks.") + `<w:sectPr>${reference("header", "h")}${reference("footer", "f")}</w:sectPr>`, [
      { id: "h", kind: "header", body: p("合成姓名") + p("alpha+audit@example.com") },
      { id: "f", kind: "footer", body: p("Only tested locally, not deployed.") },
      { id: "unused", kind: "header", body: p("UNREFERENCED: obsolete contact") },
    ]);
    await expect(extractContentFromFile("contacts.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A: parameter checks.\n\n[页眉：第 1 节默认]\n\n合成姓名\n\nalpha+audit@example.com\n\n[页脚：第 1 节默认]\n\nOnly tested locally, not deployed.\n\n" });
  });

  it("excludes disabled first/even variants and deleted section settings", async () => {
    const file = await makeDocx(p("Body") + `<w:sectPr>${reference("header", "h")}${reference("header", "first", "first")}${reference("footer", "even", "even")}<w:titlePg w:val="false"/><w:sectPrChange><w:sectPr>${reference("header", "old")}</w:sectPr></w:sectPrChange></w:sectPr>`, [
      { id: "h", kind: "header", body: p("Current") }, { id: "first", kind: "header", body: p("INACTIVE FIRST") },
      { id: "even", kind: "footer", body: p("INACTIVE EVEN") }, { id: "old", kind: "header", body: p("DELETED") },
    ], '<w:evenAndOddHeaders w:val="0"/>');
    await expect(extractContentFromFile("disabled.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Body\n\n[页眉：第 1 节默认]\n\nCurrent\n\n" });
  });

  it("labels enabled first and odd/even variants without inventing page numbers", async () => {
    const file = await makeDocx(p("Body") + `<w:sectPr>${reference("header", "h")}${reference("header", "first", "first")}${reference("header", "even", "even")}<w:titlePg/></w:sectPr>`, [
      { id: "h", kind: "header", body: p("Odd page header") }, { id: "first", kind: "header", body: p("First page header") },
      { id: "even", kind: "header", body: p("Even page header") },
    ], "<w:evenAndOddHeaders/>");
    await expect(extractContentFromFile("variants.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Body\n\n[页眉：第 1 节首页]\n\nFirst page header\n\n[页眉：第 1 节非首页奇数页]\n\nOdd page header\n\n[页眉：第 1 节非首页偶数页]\n\nEven page header\n\n" });
  });

  it("tracks inherited and replaced parts across sections without duplicating the same part", async () => {
    const section1 = `<w:p><w:pPr><w:sectPr>${reference("header", "h1")}${reference("footer", "f")}</w:sectPr></w:pPr><w:r><w:t>Section one</w:t></w:r></w:p>`;
    const section2 = `<w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>Section two</w:t></w:r></w:p>`;
    const file = await makeDocx(section1 + section2 + p("Section three") + `<w:sectPr>${reference("header", "h3")}</w:sectPr>`, [
      { id: "h1", kind: "header", body: p("Shared header") }, { id: "f", kind: "footer", body: p("Shared footer") },
      { id: "h3", kind: "header", body: p("Replacement header") },
    ]);
    await expect(extractContentFromFile("sections.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Section one\n\nSection two\n\nSection three\n\n[页眉：第 1 节默认；第 2 节默认]\n\nShared header\n\n[页脚：第 1 节默认；第 2 节默认；第 3 节默认]\n\nShared footer\n\n[页眉：第 3 节默认]\n\nReplacement header\n\n" });
  });

  it.each(["sdt", "customXml", "ins", "moveTo"])("reads a visible section boundary inside %s without using deleted section settings", async wrapper => {
    const section = `<w:p><w:pPr><w:sectPr>${reference("header", "h")}<w:sectPrChange><w:sectPr>${reference("header", "old")}</w:sectPr></w:sectPrChange></w:sectPr></w:pPr><w:r><w:t>Section one</w:t></w:r></w:p>`;
    const wrapped = wrapper === "sdt" ? `<w:sdt><w:sdtContent>${section}</w:sdtContent></w:sdt>` : `<w:${wrapper}>${section}</w:${wrapper}>`;
    const file = await makeDocx(wrapped + p("Section two") + "<w:sectPr/>", [
      { id: "h", kind: "header", body: p("Active contact") }, { id: "old", kind: "header", body: p("DELETED contact") },
    ]);
    await expect(extractContentFromFile("wrapped-section.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Section one\n\nSection two\n\n[页眉：第 1 节默认；第 2 节默认]\n\nActive contact\n\n" });
  });

  it("excludes explicitly hidden runs in both body and header while keeping an explicit false override", async () => {
    const text = '<w:p><w:r><w:t>Visible</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN: led launch</w:t></w:r><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t> only tested</w:t></w:r><w:del><w:r><w:delText>DELETED</w:delText></w:r></w:del></w:p>';
    const file = await makeDocx(text + `<w:sectPr>${reference("header", "h")}</w:sectPr>`, [{ id: "h", kind: "header", body: text }]);
    await expect(extractContentFromFile("hidden.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Visible only tested\n\n[页眉：第 1 节默认]\n\nVisible only tested\n\n" });
  });

  it.each(["missing", "external", "wrong-kind"])("rejects a %s referenced header instead of returning a partial document", async mode => {
    const file = await makeDocx(p("Body") + `<w:sectPr>${reference("header", "bad")}</w:sectPr>`, mode === "missing" ? [] : [{ id: "bad", kind: mode === "wrong-kind" ? "footer" : "header", body: p("Unexpected"), external: mode === "external", target: mode === "external" ? "https://example.invalid/header.xml" : undefined }]);
    await expect(extractContentFromFile("broken.docx", file)).rejects.toThrow(FileFormatError);
    await expect(extractContentFromFile("released.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });

  it("uses existing Word normalization and note references inside a header", async () => {
    const file = await makeDocx(p("Body") + `<w:sectPr>${reference("header", "h")}</w:sectPr>`, [{ id: "h", kind: "header", body: '<w:p><w:r><w:t><![CDATA[Array<T> & user?.name]]></w:t><w:cr/><w:t>仅测试</w:t><w:footnoteReference w:id="1"/></w:r></w:p>' }], "", {
      "word/footnotes.xml": `<w:footnotes xmlns:w="${w}"><w:footnote w:id="1">${p("未上线")}</w:footnote></w:footnotes>`,
    });
    await expect(extractContentFromFile("header-note.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Body\n\n[页眉：第 1 节默认]\n\nArray<T> & user?.name\n仅测试[脚注 1]\n\n[脚注 1]\n未上线\n\n" });
  });

  it("ignores a broken relationship inside deleted header content", async () => {
    const content = p("Visible contact") + '<w:p><w:del><w:hyperlink r:id="deleted-link"><w:r><w:delText>DELETED old contact</w:delText></w:r></w:hyperlink></w:del></w:p>';
    const file = await makeDocx(p("Body") + `<w:sectPr>${reference("header", "h")}</w:sectPr>`, [{ id: "h", kind: "header", body: content }]);
    await expect(extractContentFromFile("deleted-link.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Body\n\n[页眉：第 1 节默认]\n\nVisible contact\n\n\n\n" });
  });

  it("applies the combined code point budget to header text and generated labels", async () => {
    const prefix = "Body\n\n[页眉：第 1 节默认]\n\n";
    const text = "😀".repeat(200_000 - [...prefix].length - 2);
    const body = p("Body") + `<w:sectPr>${reference("header", "h")}</w:sectPr>`;
    await expect(extractContentFromFile("limit.docx", await makeDocx(body, [{ id: "h", kind: "header", body: p(text) }]))).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: prefix + text + "\n\n" });
    await expect(extractContentFromFile("over.docx", await makeDocx(body, [{ id: "h", kind: "header", body: p(text + "x") }]))).rejects.toThrow("200000");
  });
});
