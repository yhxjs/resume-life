import JSZip from "jszip";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractContentFromFile, type ExtractedFileContent } from "@/lib/parse-file";
import * as sandbox from "@/lib/parse-sandbox";

afterEach(() => vi.restoreAllMocks());

const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text: string, props = "") => `<w:tc><w:tcPr>${props}</w:tcPr>${p(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
const table = (...rows: string[]) => `<w:tbl><w:tblGrid>${"<w:gridCol/>".repeat(3)}</w:tblGrid>${rows.join("")}</w:tbl>`;
const restart = '<w:vMerge w:val="restart"/>';
const continued = "<w:vMerge/>";
async function extract(body: string, namespace = word, note = "") {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("word/document.xml", Buffer.from(`<w:document xmlns:w="${namespace}"><w:body>${body}</w:body></w:document>`));
  if (note) {
    zip.file("word/footnotes.xml", `<w:footnotes xmlns:w="${namespace}"><w:footnote w:id="1">${note}</w:footnote></w:footnotes>`);
    zip.file("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="notes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>');
  }
  return extractContentFromFile("table.docx", await zip.generateAsync({ type: "nodebuffer" }));
}

function markerTexts(result: ExtractedFileContent) {
  expect(result.tableProvenance).toMatchObject({ version: 1, format: "docx", offsetUnit: "utf16",
    textSha256: createHash("sha256").update(result.text).digest("hex") });
  const markers = result.tableProvenance!.markers;
  let previousEnd = 0;
  for (const marker of markers) {
    expect(marker.start).toBeGreaterThanOrEqual(previousEnd);
    expect(marker.end).toBeGreaterThan(marker.start);
    expect(marker.end).toBeLessThanOrEqual(result.text.length);
    previousEnd = marker.end;
  }
  return markers.map(marker => result.text.slice(marker.start, marker.end));
}

describe("DOCX table fact ownership", () => {
  it("distinguishes one project with two responsibilities from two projects sharing a responsibility", async () => {
    const header = row(cell("项目"), cell("职责"), cell("状态"));
    const first = await extract(table(header,
      row(cell("数据导入", restart), cell("参与测试"), cell("未上线", restart)),
      row(cell("", continued), cell("参数校验"), cell("", continued))));
    const second = await extract(table(header,
      row(cell("数据导入"), cell("参与测试", restart), cell("未上线", restart)),
      row(cell("参数校验"), cell("", continued), cell("", continued))));
    expect(first).not.toEqual(second);
    expect(first.text).toContain("[第 2 行，第 1 列；跨 2 行]\n\n数据导入\n\n");
    expect(first.text).toContain("[第 3 行，第 2 列]\n\n参数校验\n\n");
    expect(second.text).toContain("[第 2 行，第 2 列；跨 2 行]\n\n参与测试\n\n");
    expect(second.text).toContain("[第 3 行，第 1 列]\n\n参数校验\n\n");
    expect(first.text.match(/未上线/g)).toHaveLength(1);
  });

  it.each([word, "http://purl.oclc.org/ooxml/wordprocessingml/main"])("uses omitted leading columns when resolving vertical merges in %s", async namespace => {
    const source = table(
      row('<w:trPr><w:gridBefore w:val="1"/></w:trPr>', cell("职责", restart), cell("状态")),
      row(cell("项目"), cell("", continued), cell("未上线")));
    const { text } = await extract(source, namespace);
    expect(text).toContain("[第 1 行；前空缺 1 列]\n\n");
    expect(text).toContain("[第 1 行，第 2 列；跨 2 行]\n\n职责\n\n");
    expect(text).toContain("[第 2 行，第 1 列]\n\n项目\n\n");
    expect(text).toContain("[第 2 行，第 3 列]\n\n未上线\n\n");
  });

  it("retains two-dimensional merges, empty cells and omitted trailing columns", async () => {
    const result = await extract(table(
      row(cell("共同职责", '<w:gridSpan w:val="2"/>' + restart), cell("")),
      row('<w:trPr><w:gridAfter w:val="1"/></w:trPr>', cell("", '<w:gridSpan w:val="2"/>' + continued))));
    const { text } = result;
    expect(text).toContain("[第 1 行，第 1 列；跨 2 行；跨 2 列]\n\n共同职责\n\n");
    expect(text).toContain("[第 1 行，第 3 列]\n\n\n\n");
    expect(text).toContain("[第 2 行；后空缺 1 列]\n\n");
    expect(markerTexts(result)).toEqual(["[表格]", "[第 1 行]", "[第 1 行，第 1 列；跨 2 行；跨 2 列]",
      "[第 1 行，第 3 列]", "[第 2 行；后空缺 1 列]", "[表格结束]"]);
  });

  it("keeps nested table boundaries and literal text, tabs and line breaks inside their owning cell", async () => {
    const nested = table(row(cell("内层职责"), cell("未上线")));
    const source = table(row(`<w:tc>${p("Array&lt;T&gt; | [表格结束]")}<w:p><w:r><w:t>仅测试</w:t><w:tab/><w:br/><w:br/><w:t>无指标</w:t></w:r></w:p>${nested}${p("外层结尾")}</w:tc>`, cell("邻列")));
    const result = await extract(source);
    const { text } = result;
    expect(text).toContain("Array<T> | [表格结束]\n\n仅测试\t\n\n无指标\n\n[表格]\n\n");
    expect(text).toContain("[表格结束]\n\n外层结尾\n\n[第 1 行，第 2 列]\n\n邻列");
    expect(markerTexts(result)).toEqual(["[表格]", "[第 1 行]", "[第 1 行，第 1 列]", "[表格]", "[第 1 行]",
      "[第 1 行，第 1 列]", "[第 1 行，第 2 列]", "[表格结束]", "[第 1 行，第 2 列]", "[表格结束]"]);
    expect(result.tableProvenance!.markers.some(marker => marker.start === text.indexOf("[表格结束]"))).toBe(false);
  });

  it("follows visible row/cell wrappers and excludes deleted rows and previous table properties", async () => {
    const source = table(
      row('<w:trPr><w:del/></w:trPr>', cell("已删除")),
      `<w:sdt><w:sdtPr>${row(cell("隐藏元数据"))}</w:sdtPr><w:sdtContent>${row(`<w:customXml>${cell("仅测试")}</w:customXml>`, cell("未上线"))}</w:sdtContent></w:sdt>`,
      `<w:del>${row(cell("旧数据"))}</w:del>`);
    const { text } = await extract(source);
    expect(text).toContain("[第 1 行，第 1 列]\n\n仅测试\n\n");
    expect(text).not.toMatch(/已删除|隐藏元数据|旧数据/);
  });

  it.each(["0", "-1", "1.5", "999999999999999999999999"])("rejects unreliable table grid spans %s", async value => {
    await expect(extract(table(row(cell("事实", `<w:gridSpan w:val="${value}"/>`))))).rejects.toThrow("表格");
  });

  it("does not attach a continuation to a different-width or nonadjacent merge", async () => {
    await expect(extract(table(row(cell("A", restart)), row(cell("", '<w:gridSpan w:val="2"/>' + continued))))).rejects.toThrow("表格");
    await expect(extract(table(row(cell("A", restart)), row('<w:trPr><w:gridBefore w:val="1"/></w:trPr>', cell("B")), row(cell("", continued))))).rejects.toThrow("表格");
  });

  it("rejects an invalid table only when its note is actually referenced", async () => {
    const invalid = table(row(cell("旧记录", '<w:gridSpan w:val="0"/>')));
    await expect(extract(p("仅测试"), word, invalid)).resolves.toEqual({ tableProvenance: expect.objectContaining({ version: 1, format: "docx", offsetUnit: "utf16" }), text: "仅测试\n\n" });
    await expect(extract('<w:p><w:r><w:footnoteReference w:id="1"/></w:r></w:p>', word, invalid)).rejects.toThrow("表格");
  });

  it("handles legacy horizontal merges equivalently to a single gridSpan cell", async () => {
    const legacy = await extract(table(row(cell("共同职责", '<w:hMerge w:val="restart"/>'), cell("", "<w:hMerge/>"), cell("未上线"))));
    const modern = await extract(table(row(cell("共同职责", '<w:gridSpan w:val="2"/>'), cell("未上线"))));
    expect(legacy).toEqual(modern);
    expect(modern.text).toContain("[第 1 行，第 1 列；跨 2 列]\n\n共同职责\n\n");
  });

  it.each(["vMerge", "hMerge"])("does not validate a nested table discarded with a %s continuation", async kind => {
    const invalid = table(row(cell("旧记录", '<w:gridSpan w:val="0"/>')));
    const start = cell("合并起点", `<w:${kind} w:val="restart"/>`);
    const continuation = `<w:tc><w:tcPr><w:${kind}/></w:tcPr>${invalid}</w:tc>`;
    const { text } = await extract(kind === "vMerge" ? table(row(start), row(continuation)) : table(row(start, continuation)));
    expect(text).toContain("合并起点");
    expect(text).not.toMatch(/旧记录|[0-9a-f]{8}-[0-9a-f-]{27}/);
  });

  it("preserves a referenced note from a cell alongside its column and merge labels", async () => {
    const source = table(row('<w:tc><w:p><w:r><w:t>参与测试</w:t><w:footnoteReference w:id="1"/></w:r></w:p></w:tc>', cell("2024")));
    const result = await extract(source, word, p("未上线，收益未验证"));
    const { text } = result;
    expect(text).toContain("[第 1 行，第 1 列]\n\n参与测试[脚注 1]\n\n[第 1 行，第 2 列]");
    expect(text).toContain("[表格结束]\n\n[脚注 1]\n未上线，收益未验证\n\n");
    expect(markerTexts(result)).toEqual(["[表格]", "[第 1 行]", "[第 1 行，第 1 列]", "[第 1 行，第 2 列]", "[表格结束]"]);
  });

  it("uses UTF16 offsets without labelling user-authored table-like text", async () => {
    const literal = "😀[表格][第 1 行][第 1 行，第 1 列][表格结束]";
    const result = await extract(p(literal) + table(row(cell("😀[表格结束]"))));
    expect(result.text).toBe(`${literal}\n\n[表格]\n\n[第 1 行]\n\n[第 1 行，第 1 列]\n\n😀[表格结束]\n\n[表格结束]\n\n`);
    expect(markerTexts(result)).toEqual(["[表格]", "[第 1 行]", "[第 1 行，第 1 列]", "[表格结束]"]);
    expect(result.tableProvenance!.markers[0]!.start).toBe(literal.length + 2);
    expect(result.tableProvenance!.markers.at(-1)!.start).toBe(result.text.lastIndexOf("[表格结束]"));
  });

  it("bounds emitted marker metadata inside the worker before IPC", async () => {
    const runWorker = sandbox.runInSandboxedWorker;
    const observed: unknown[] = [];
    vi.spyOn(sandbox, "runInSandboxedWorker").mockImplementation((source, data, limits, timeout, read, options) =>
      runWorker(source, { ...data, maxTableMarkers: 4 }, limits, timeout, message => {
        observed.push(message);
        return read(message);
      }, options));
    const result = await extract(table(row(cell("可靠正文"))));
    expect(markerTexts(result)).toHaveLength(4);
    expect((observed[0] as { tableMarkers: Uint32Array }).tableMarkers.byteLength).toBe(4 * 2 * 4);
    await expect(extract(table(row(cell("可靠正文"), cell("额外一格"))))).rejects.toThrow("表格结构标记");
    expect(observed[1]).toEqual({ tooManyTableMarkers: true });
    await expect(extractContentFromFile("released.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });

  it("counts structural labels and supplementary text in the extraction limit without expanding large spans", async () => {
    const single = await extract(table(row(cell("x", '<w:gridSpan w:val="999999"/>'))));
    expect(single.text.length).toBeLessThan(200);
    const room = 200_000 - [...single.text].length + 1;
    const source = (text: string) => table(row(cell(text, '<w:gridSpan w:val="999999"/>')));
    const atLimit = await extract(source("😀".repeat(room)));
    expect([...atLimit.text]).toHaveLength(200_000);
    await expect(extract(source("😀".repeat(room) + "x"))).rejects.toThrow("200000");
    await expect(extractContentFromFile("released.txt", Buffer.from("released"))).resolves.toEqual({ text: "released" });
  });
});
