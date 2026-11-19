import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractContentFromFile } from "@/lib/parse-file";
import { FileFormatError } from "@/lib/parse-sandbox";

type NoteKind = "footnote" | "endnote";
type Note = { kind: NoteKind; id: string; body: string; type?: string };
const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const relationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function text(text: string): string { return `<w:t xml:space="preserve">${escaped(text)}</w:t>`; }
function paragraph(contents: string): string { return `<w:p><w:r>${contents}</w:r></w:p>`; }
function reference(kind: NoteKind, id: string): string { return `<w:${kind}Reference w:id="${id}"/>`; }

/** Uses real note parts and document relationships, including Word separator records. */
async function makeDocx(body: string, notes: Note[]): Promise<Buffer> {
  const zip = new JSZip();
  const kinds = ["footnote", "endnote"] as const;
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${kinds.map(kind => `<Override PartName="/word/${kind}s.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}s+xml"/>`).join("")}</Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${relationshipNamespace}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<w:document xmlns:w="${wordNamespace}"><w:body>${body}</w:body></w:document>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${kinds.map(kind => `<Relationship Id="${kind}" Type="${relationshipNamespace}/${kind}s" Target="${kind}s.xml"/>`).join("")}</Relationships>`);
  for (const kind of kinds) {
    const entries = notes.filter(note => note.kind === kind).map(note => `<w:${kind} w:id="${note.id}"${note.type ? ` w:type="${note.type}"` : ""}>${note.body}</w:${kind}>`).join("");
    zip.file(`word/${kind}s.xml`, `<w:${kind}s xmlns:w="${wordNamespace}"><w:${kind} w:id="-1" w:type="separator">${paragraph("<w:separator/>")}</w:${kind}><w:${kind} w:id="0" w:type="continuationSeparator">${paragraph("<w:continuationSeparator/>")}</w:${kind}>${entries}</w:${kind}s>`);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

describe("DOCX referenced footnote and endnote fidelity", () => {
  it.each([
    { kind: "footnote" as const, label: "脚注" },
    { kind: "endnote" as const, label: "尾注" },
  ])("preserves referenced $label qualifications and technical literals after the complete body", async ({ kind, label }) => {
    const qualification = "仅做本地测试，未上线；收益尚未验证。Array<T> &amp; user?.name ?? fallback";
    const file = await makeDocx(
      paragraph(text("参数校验") + reference(kind, "17") + text("，后续继续维护。")) + paragraph(text("正文第二段。")),
      [{ kind, id: "17", body: paragraph(`<w:${kind}Ref/>` + text(qualification)) + paragraph(text("  C:\\projects\\demo  ")) }],
    );
    await expect(extractContentFromFile("qualification.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }),
      text: `参数校验[${label} 1]，后续继续维护。\n\n正文第二段。\n\n[${label} 1]\n${qualification}\n\n  C:\\projects\\demo  \n\n`,
    });
  });

  it("numbers each note type by first reference, repeats markers, and appends each definition once in discovery order", async () => {
    const file = await makeDocx(
      paragraph(text("甲") + reference("footnote", "9") + text("乙") + reference("endnote", "9") +
        text("丙") + reference("footnote", "2") + text("丁") + reference("footnote", "9") + reference("endnote", "9")),
      [
        { kind: "footnote", id: "2", body: paragraph(text("第二个引用的脚注")) },
        { kind: "footnote", id: "9", body: paragraph(text("第一个引用的脚注")) },
        { kind: "endnote", id: "9", body: paragraph(text("同 ID 尾注不与脚注混淆")) },
        { kind: "footnote", id: "88", body: paragraph(text("未引用旧记录：团队下降 50%")) },
        { kind: "endnote", id: "88", body: paragraph(text("未引用尾注")) },
      ],
    );
    await expect(extractContentFromFile("repeated.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }),
      text: "甲[脚注 1]乙[尾注 1]丙[脚注 2]丁[脚注 1][尾注 1]\n\n" +
        "[脚注 1]\n第一个引用的脚注\n\n[尾注 1]\n同 ID 尾注不与脚注混淆\n\n[脚注 2]\n第二个引用的脚注\n\n",
    });
  });

  it("ignores unreferenced notes and separators, including long note bodies and dangling references", async () => {
    const file = await makeDocx(paragraph(text("只有这段正文。")), [
      { kind: "footnote", id: "3", body: paragraph(text("😀".repeat(200_001))) },
      { kind: "endnote", id: "4", body: paragraph(reference("footnote", "404")) },
    ]);
    await expect(extractContentFromFile("unreferenced.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "只有这段正文。\n\n" });
  });

  it("follows referenced note chains and terminates a cross-type cycle without duplicating definitions", async () => {
    const file = await makeDocx(paragraph(text("正文") + reference("footnote", "5")), [
      { kind: "footnote", id: "5", body: paragraph(text("仅测试") + reference("endnote", "7")) },
      { kind: "endnote", id: "7", body: paragraph(text("未上线，回到原注") + reference("footnote", "5")) },
    ]);
    await expect(extractContentFromFile("cycle.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }),
      text: "正文[脚注 1]\n\n[脚注 1]\n仅测试[尾注 1]\n\n[尾注 1]\n未上线，回到原注[脚注 1]\n\n",
    });
  });

  it("appends a note discovered inside another definition after all already referenced definitions", async () => {
    const file = await makeDocx(paragraph(reference("footnote", "1") + reference("footnote", "2")), [
      { kind: "footnote", id: "1", body: paragraph(text("一") + reference("endnote", "4")) },
      { kind: "footnote", id: "2", body: paragraph(text("二")) },
      { kind: "endnote", id: "4", body: paragraph(text("三")) },
    ]);
    await expect(extractContentFromFile("discovery-order.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }),
      text: "[脚注 1][脚注 2]\n\n[脚注 1]\n一[尾注 1]\n\n[脚注 2]\n二\n\n[尾注 1]\n三\n\n",
    });
  });

  it.each(["footnote", "endnote"] as const)("rejects a missing referenced %s instead of silently dropping the marker", async kind => {
    const file = await makeDocx(paragraph(text("正文") + reference(kind, "404")), []);
    await expect(extractContentFromFile("missing.docx", file)).rejects.toThrow(FileFormatError);
    await expect(extractContentFromFile("released.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });

  it("rejects a missing target reached from a referenced definition", async () => {
    const file = await makeDocx(paragraph(text("正文") + reference("footnote", "1")), [
      { kind: "footnote", id: "1", body: paragraph(text("限定") + reference("endnote", "404")) },
    ]);
    await expect(extractContentFromFile("missing-nested.docx", file)).rejects.toThrow(FileFormatError);
  });

  it("preserves carriage returns, mixed CDATA and literal reference-looking text inside a referenced note", async () => {
    const file = await makeDocx(paragraph(text("正文") + reference("footnote", "1")), [{
      kind: "footnote", id: "1",
      body: paragraph(text("尚未上线") + "<w:cr/><w:t>before <![CDATA[Array<T> & user?.name ?? fallback]]> after</w:t>" +
        '<word:cr xmlns:word="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' + text("[脚注 1] 是原文，不是新增引用")),
    }]);
    await expect(extractContentFromFile("note-breaks.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }),
      text: "正文[脚注 1]\n\n[脚注 1]\n尚未上线\nbefore Array<T> & user?.name ?? fallback after\n[脚注 1] 是原文，不是新增引用\n\n",
    });
  });

  it("counts reference markers, note definitions and supplementary characters in the combined text limit", async () => {
    const prefix = "正文[脚注 1]\n\n[脚注 1]\n";
    const suffix = "\n\n";
    const content = "😀".repeat(200_000 - [...prefix, ...suffix].length);
    const file = await makeDocx(paragraph(text("正文") + reference("footnote", "1")), [
      { kind: "footnote", id: "1", body: paragraph(text(content)) },
    ]);
    await expect(extractContentFromFile("at-limit.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: prefix + content + suffix });
    const over = await makeDocx(paragraph(text("正文") + reference("footnote", "1")), [
      { kind: "footnote", id: "1", body: paragraph(text(content + "x")) },
    ]);
    await expect(extractContentFromFile("over-limit.docx", over)).rejects.toThrow(/200000/);
    await expect(extractContentFromFile("released.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });
});
