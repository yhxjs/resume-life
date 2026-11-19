import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractContentFromFile } from "@/lib/parse-file";
import { FileFormatError } from "@/lib/parse-sandbox";

async function makeDocx(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

describe("DOCX source text fidelity", () => {
  it.each([
    { name: "manual line break", xml: "<w:br/>" },
    { name: "explicit text-wrapping break", xml: '<w:br w:type="textWrapping"/>' },
    { name: "page break", xml: '<w:br w:type="page"/>' },
    { name: "column break", xml: '<w:br w:type="column"/>' },
  ])("preserves a $name between facts in the same run", async ({ xml }) => {
    const file = await makeDocx(`<w:p><w:r><w:t>仅参与参数校验，未上线。</w:t>${xml}<w:t>团队完成 50%，个人仅测试。</w:t></w:r></w:p>`);
    await expect(extractContentFromFile("source.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }),
      text: "仅参与参数校验，未上线。\n团队完成 50%，个人仅测试。\n\n",
    });
  });

  it("keeps repeated breaks across styled runs and inside table cells", async () => {
    const file = await makeDocx('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Project A</w:t><w:br/></w:r><w:r><w:rPr><w:b/></w:rPr><w:br/><w:t>not deployed</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2024</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
    await expect(extractContentFromFile("table.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "[表格]\n\n[第 1 行]\n\n[第 1 行，第 1 列]\n\nProject A\n\nnot deployed\n\n[第 1 行，第 2 列]\n\n2024\n\n[表格结束]\n\n" });
  });

  it("retains literal punctuation, tabs, paragraph spacing and adjacent font runs", async () => {
    const file = await makeDocx('<w:p><w:r><w:t>Array&lt;</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>T</w:t></w:r><w:r><w:t>&gt;</w:t><w:tab/><w:t>user?.name ?? fallback</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">  alpha+audit@example.com &amp; https://example.com/?q=1&amp;x=2  </w:t></w:r></w:p>');
    await expect(extractContentFromFile("literal.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }),
      text: "Array<T>\tuser?.name ?? fallback\n\n  alpha+audit@example.com & https://example.com/?q=1&x=2  \n\n",
    });
  });

  it.each([
    { name: "standard prefix", xml: "<w:cr/>" },
    { name: "local alias", xml: '<word:cr xmlns:word="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' },
    { name: "default namespace", xml: '<cr xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>' },
    { name: "strict namespace alias", xml: '<s:cr xmlns:s="http://purl.oclc.org/ooxml/wordprocessingml/main"/>' },
    { name: "strict default namespace", xml: '<cr xmlns="http://purl.oclc.org/ooxml/wordprocessingml/main"/>' },
  ])("preserves a carriage-return break with $name", async ({ xml }) => {
    const file = await makeDocx(`<w:p><w:r><w:t>Project A</w:t>${xml}<w:t>not deployed</w:t></w:r></w:p>`);
    await expect(extractContentFromFile("carriage-return.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A\nnot deployed\n\n" });
  });

  it("normalizes only real Word breaks, retaining text literals, whitespace and foreign elements", async () => {
    const file = await makeDocx('<w:p><w:r><w:t xml:space="preserve">  &lt;w:cr/&gt; &amp; Array&lt;T&gt;  </w:t><!-- <w:cr/> --><x:cr xmlns:x="urn:synthetic"/><w:cr/><w:t><![CDATA[user?.name ?? fallback & <word:cr/>]]></w:t><w:cr/><w:cr/></w:r></w:p>');
    await expect(extractContentFromFile("literals.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "  <w:cr/> & Array<T>  \nuser?.name ?? fallback & <word:cr/>\n\n\n\n" });
  });

  it.each([
    { name: "only CDATA", xml: "<![CDATA[Array<T> & user?.name]]>", text: "Array<T> & user?.name" },
    { name: "mixed text and CDATA", xml: "before <![CDATA[Array<T>]]> &amp; after", text: "before Array<T> & after" },
  ])("keeps $name inside a Word text node without requiring a carriage-return break", async ({ xml, text }) => {
    const file = await makeDocx(`<w:p><w:r><w:t>${xml}</w:t></w:r></w:p>`);
    await expect(extractContentFromFile("cdata.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: text + "\n\n" });
  });

  it("reads carriage returns from a main document at its package relationship path", async () => {
    const zip = await JSZip.loadAsync(await makeDocx("<w:p><w:r><w:t>Project A</w:t><w:cr/><w:t>not deployed</w:t></w:r></w:p>"));
    zip.file("documents/resume.xml", await zip.file("word/document.xml")!.async("string"));
    zip.remove("word/document.xml");
    zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="documents/resume.xml"/></Relationships>');
    await expect(extractContentFromFile("relocated.docx", await zip.generateAsync({ type: "nodebuffer" }))).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Project A\nnot deployed\n\n" });
  });

  it("ignores damaged embedded styles that do not affect source text", async () => {
    const zip = await JSZip.loadAsync(await makeDocx("<w:p><w:r><w:t>Valid body</w:t><w:br/><w:t>not deployed</w:t></w:r></w:p>"));
    zip.file("mammoth/style-map", "p => h1:fresh");
    const file = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    let corrupted = false;
    for (let offset = 0; offset + 46 < file.length; offset++) {
      if (file.readUInt32LE(offset) !== 0x02014b50) continue;
      const nameLength = file.readUInt16LE(offset + 28);
      if (file.subarray(offset + 46, offset + 46 + nameLength).toString() !== "mammoth/style-map") continue;
      const local = file.readUInt32LE(offset + 42);
      const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
      file.fill(0xff, start, start + file.readUInt32LE(offset + 20));
      corrupted = true;
      break;
    }
    expect(corrupted).toBe(true);
    await expect(extractContentFromFile("styles.docx", file)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "Valid body\nnot deployed\n\n" });
  });

  it.each(["br", "cr"])("counts %s breaks and supplementary characters in the 200000-character limit", async tag => {
    const text = "😀".repeat(199_997);
    const atLimit = await makeDocx(`<w:p><w:r><w:t>${text}</w:t><w:${tag}/></w:r></w:p>`);
    await expect(extractContentFromFile("limit.docx", atLimit)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: text + "\n\n\n" });
    const overLimit = await makeDocx(`<w:p><w:r><w:t>${text}x</w:t><w:${tag}/></w:r></w:p>`);
    await expect(extractContentFromFile("over.docx", overLimit)).rejects.toThrow(FileFormatError);
    await expect(extractContentFromFile("released.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });
});
