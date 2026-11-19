import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractContentFromFile } from "../parse-file";
import type { PdfPageImage } from "../pdf-to-images";
import type { LocalOcrOptions } from "../ocr-local";
import type { OcrMode } from "../settings";

const mocks = vi.hoisted(() => ({
  mode: "vision" as OcrMode,
  vision: vi.fn<(pages: PdfPageImage[], signal?: AbortSignal) => Promise<string>>(),
  local: vi.fn<(pages: PdfPageImage[], options?: LocalOcrOptions) => Promise<string>>(),
}));
vi.mock("../settings", () => ({ readSettings: () => ({ ocr_mode: mocks.mode }) }));
vi.mock("../ocr-vision", () => ({ ocrPdfPagesWithVision: mocks.vision }));
vi.mock("../ocr-local", () => ({ ocrPdfPagesLocally: mocks.local }));

type FixturePage = { kind: "text" | "scan"; text: string } | { kind: "scan-with-header"; text: string; header: string } | { kind: "blank" };
let temporary: string;
let fixturePages: FixturePage[];

function pdfStream(bytes: Buffer, attributes = ""): Buffer {
  return Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} ${attributes} >>\nstream\n`),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}

/** Real selectable text and raster-only text pages; only OCR recognition is mocked. */
function makePdf(pages: FixturePage[]): Buffer {
  fixturePages = pages;
  const objects: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0)];
  const append = (object: Buffer | string) => {
    objects.push(typeof object === "string" ? Buffer.from(object) : object);
    return objects.length;
  };
  const fontId = append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = pages.map((page) => {
    const pageId = append(Buffer.alloc(0));
    let resources = "<< >>";
    let commands = "";
    if (page.kind === "text") {
      const escaped = page.text.replace(/[\\()]/g, "\\$&");
      resources = `<< /Font << /F1 ${fontId} 0 R >> >>`;
      commands = `BT /F1 16 Tf 30 730 Td (${escaped}) Tj ET`;
    } else if (page.kind === "scan" || page.kind === "scan-with-header") {
      const canvas = createCanvas(600, 800);
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 600, 800);
      context.fillStyle = "black";
      context.font = "16px Arial";
      context.fillText(page.text, 30, 70);
      const imageId = append(pdfStream(canvas.toBuffer("image/jpeg"),
        "/Type /XObject /Subtype /Image /Width 600 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"));
      resources = `<< /XObject << /Im1 ${imageId} 0 R >> >>`;
      commands = "q 600 0 0 800 0 0 cm /Im1 Do Q";
      if (page.kind === "scan-with-header") {
        resources = `<< /XObject << /Im1 ${imageId} 0 R >> /Font << /F1 ${fontId} 0 R >> >>`;
        commands += ` BT /F1 16 Tf 30 770 Td (${page.header.replace(/[\\()]/g, "\\$&")}) Tj ET`;
      }
    }
    const contentId = append(pdfStream(Buffer.from(commands)));
    objects[pageId - 1] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources ${resources} /Contents ${contentId} 0 R >>`);
    return pageId;
  });
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);

  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let offset = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(part);
    offset += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
  const buffer = Buffer.concat(parts);
  fs.writeFileSync(path.join(temporary, "fixture.pdf"), buffer);
  fs.writeFileSync(path.join(temporary, "pages.json"), JSON.stringify(pages, null, 2));
  return buffer;
}

function recognizedText(pages: PdfPageImage[]): string {
  return pages.map((page) => {
    const source = fixturePages[page.pageNumber - 1];
    expect(source?.kind, "OCR must receive only original raster text pages").toBe("scan");
    expect(page.hasVisualContent).toBe(true);
    expect(page.buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(page.base64).toBe(`data:image/png;base64,${page.buffer.toString("base64")}`);
    return source && source.kind !== "blank" ? source.text : "";
  }).join("\n\n");
}

const textPage = (text: string): FixturePage => ({ kind: "text", text });
const scanPage = (text: string): FixturePage => ({ kind: "scan", text });
const callPages = (calls: [PdfPageImage[], ...unknown[]][]) => calls.map(([pages]) => pages.map(page => page.pageNumber));
const textOnly = "SELECTABLE: own tests, not deployed; Array<T> &amp; 50%.";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode = "vision";
  fixturePages = [];
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-mixed-pdf-"));
  mocks.vision.mockImplementation(async pages => recognizedText(pages));
  mocks.local.mockImplementation(async pages => recognizedText(pages));
});

afterEach(({ task }) => {
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("resume-life-mixed-pdf-")) {
    throw new Error(`Unsafe mixed PDF fixture cleanup target: ${resolved}`);
  }
  if (task.result?.state === "fail") {
    fs.writeFileSync(path.join(resolved, "ocr-calls.json"), JSON.stringify({
      test: task.name, mode: mocks.mode,
      vision: callPages(mocks.vision.mock.calls), local: callPages(mocks.local.mock.calls),
    }, null, 2));
    console.warn(`Mixed PDF failure evidence: ${resolved}`);
  } else {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("mixed PDF text and OCR extraction", () => {
  it("explicit PDF image mode recognizes a selectable page without merging its text layer again", async () => {
    const pdf = makePdf([textPage(textOnly)]);
    expect(await extractContentFromFile("selectable.pdf", pdf)).toEqual({text:textOnly});
    expect(mocks.vision).not.toHaveBeenCalled();
    mocks.vision.mockImplementation(async pages => {
      expect(pages.map(page=>page.pageNumber)).toEqual([1]);
      expect(pages[0]!.hasVisualContent).toBe(true);
      return "IMAGE SOURCE: assisted tests; not deployed.";
    });
    expect(await extractContentFromFile("selectable.PDF",pdf,{pdfMode:"image"})).toEqual({
      text:"IMAGE SOURCE: assisted tests; not deployed.",ocr:{engine:"vision",pageCount:1,sourceType:"pdf"},
    });
    expect(mocks.vision).toHaveBeenCalledOnce();
  });

  it("explicit PDF image mode sends both selectable and scanned pages in original order", async () => {
    mocks.vision.mockImplementation(async pages => {
      expect(pages.map(page=>page.pageNumber)).toEqual([1,2]);
      return "OCR first page\n\nOCR second page";
    });
    expect(await extractContentFromFile("mixed.pdf",makePdf([textPage(textOnly),scanPage("SECOND PAGE")]),{pdfMode:"image"}))
      .toEqual({text:"OCR first page\n\nOCR second page",ocr:{engine:"vision",pageCount:2,sourceType:"pdf"}});
    expect(mocks.vision).toHaveBeenCalledOnce();
  });

  it("explicit PDF image mode respects disabled OCR without claiming that the text layer is absent", async () => {
    mocks.mode="off";
    await expect(extractContentFromFile("text.pdf",makePdf([textPage(textOnly)]),{pdfMode:"image"}))
      .rejects.toThrow("按页面图片识别需要 OCR");
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("explicit PDF image mode rejects more than five selectable pages before recognition", async () => {
    await expect(extractContentFromFile("six.pdf",makePdf(Array.from({length:6},()=>textPage(textOnly))),{pdfMode:"image"}))
      .rejects.toThrow(/共 6 页.*最多支持 5 页/);
    expect(mocks.vision).not.toHaveBeenCalled();
  });

  it("explicit PDF image mode rejects other file types without invoking OCR", async () => {
    await expect(extractContentFromFile("source.txt",Buffer.from(textOnly),{pdfMode:"image"})).rejects.toThrow("仅支持 PDF");
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("explicit PDF image mode includes a same-page scanned body even when a selectable header exists", async () => {
    const header="SELECTABLE HEADER";
    const body="SCANNED BODY: assisted testing, not deployed.";
    const pdf=makePdf([{kind:"scan-with-header",header,text:body}]);
    expect(await extractContentFromFile("header.pdf",pdf)).toEqual({text:header});
    expect(mocks.vision).not.toHaveBeenCalled();
    mocks.vision.mockImplementation(async pages=>{
      expect(pages).toHaveLength(1);
      expect(pages[0]!.buffer.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");
      return `${header}\n${body}`;
    });
    expect(await extractContentFromFile("header.pdf",pdf,{pdfMode:"image"})).toEqual({
      text:`${header}\n${body}`,ocr:{engine:"vision",pageCount:1,sourceType:"pdf"},
    });
  });

  it("explicit PDF image mode preserves cancellation and does not return late recognition or fall back", async () => {
    mocks.mode="auto";
    const controller=new AbortController();
    const reason=new Error("cancelled explicit image recognition");
    mocks.vision.mockImplementation(async()=>{controller.abort(reason);return "late result";});
    await expect(extractContentFromFile("cancelled.pdf",makePdf([textPage(textOnly)]),{pdfMode:"image",signal:controller.signal})).rejects.toBe(reason);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("keeps selectable text around a scanned page in source order and sends only that page to OCR", async () => {
    const middle = "SCANNED: helped test the interface; result unverified.";
    const ending = "SELECTABLE END: duties still limited to testing.";
    const result = await extractContentFromFile("mixed.pdf", makePdf([textPage(textOnly), scanPage(middle), textPage(ending)]));
    expect(result).toEqual({ text: [textOnly, middle, ending].join("\n\n"), ocr: { engine: "vision", pageCount: 1, sourceType: "pdf" } });
    expect(callPages(mocks.vision.mock.calls)).toEqual([[2]]);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("recognizes nonadjacent scanned pages separately with their original page numbers", async () => {
    const first = "SCANNED FIRST: actual maintenance task.";
    const last = "SCANNED LAST: no measured benefit yet.";
    const result = await extractContentFromFile("nonadjacent.pdf", makePdf([scanPage(first), textPage(textOnly), scanPage(last)]));
    expect(result).toEqual({ text: [first, textOnly, last].join("\n\n"), ocr: { engine: "vision", pageCount: 2, sourceType: "pdf" } });
    expect(callPages(mocks.vision.mock.calls)).toEqual([[1], [3]]);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("recognizes adjacent scanned pages together without reprocessing selectable pages", async () => {
    const second = "SCANNED SECOND: implemented parameter checks.";
    const third = "SCANNED THIRD: tests passed locally, not deployed.";
    const last = "SELECTABLE LAST: follow-up is pending.";
    const result = await extractContentFromFile("adjacent.pdf", makePdf([textPage(textOnly), scanPage(second), scanPage(third), textPage(last)]));
    expect(result).toEqual({ text: [textOnly, second, third, last].join("\n\n"), ocr: { engine: "vision", pageCount: 2, sourceType: "pdf" } });
    expect(callPages(mocks.vision.mock.calls)).toEqual([[2, 3]]);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("ignores genuinely blank pages with OCR disabled", async () => {
    mocks.mode = "off";
    const last = "SELECTABLE LAST: preserve this page.";
    const result = await extractContentFromFile("blank-pages.pdf", makePdf([textPage(textOnly), { kind: "blank" }, { kind: "blank" }, textPage(last)]));
    expect(result.text.split(/\n+/)).toEqual([textOnly, last]);
    expect(result.ocr).toBeUndefined();
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("rejects a mixed PDF requiring OCR when OCR is disabled instead of returning a partial document", async () => {
    mocks.mode = "off";
    await expect(extractContentFromFile("ocr-disabled.pdf", makePdf([textPage(textOnly), scanPage("SCANNED: this must not disappear.")]))).rejects.toThrow(/关闭.*OCR|OCR.*关闭/);
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("auto retries all OCR groups locally after a later vision failure while keeping selectable text intact", async () => {
    mocks.mode = "auto";
    const first = "SCANNED FIRST: local version of the source.";
    const last = "SCANNED LAST: local version of the ending.";
    mocks.vision.mockImplementationOnce(async pages => `${recognizedText(pages)} VISION_VARIANT`)
      .mockRejectedValueOnce(new Error("synthetic later-group failure"));
    const result = await extractContentFromFile("fallback.pdf", makePdf([scanPage(first), textPage(textOnly), scanPage(last)]));
    expect(result).toEqual({ text: [first, textOnly, last].join("\n\n"), ocr: { engine: "local", pageCount: 2, sourceType: "pdf" } });
    expect(callPages(mocks.vision.mock.calls)).toEqual([[1], [3]]);
    expect(callPages(mocks.local.mock.calls)).toEqual([[1], [3]]);
    expect(result.text).not.toContain("VISION_VARIANT");
  });

  it("rejects the entire document when one required OCR group has no effective text", async () => {
    mocks.mode = "local";
    mocks.local.mockImplementationOnce(async pages => recognizedText(pages)).mockResolvedValueOnce(" \u200b...\n ");
    await expect(extractContentFromFile("missing-group.pdf", makePdf([
      scanPage("SCANNED FIRST: readable."), textPage(textOnly), scanPage("SCANNED LAST: required content."),
    ]))).rejects.toThrow(/文字|识别|OCR/);
    expect(callPages(mocks.local.mock.calls)).toEqual([[1], [3]]);
    expect(mocks.vision).not.toHaveBeenCalled();
  });

  it("returns six-page selectable PDFs unchanged without OCR metadata or calls", async () => {
    mocks.mode = "off";
    const texts = [textOnly, ...Array.from({ length: 5 }, (_, index) => `SELECTABLE PAGE ${index + 2}: team results are not personal ownership.`)];
    expect(await extractContentFromFile("text-only.pdf", makePdf(texts.map(textPage)))).toEqual({ text: texts.join("\n\n") });
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("does not apply the OCR page cap to selectable text with six truly empty appendix pages", async () => {
    mocks.mode = "off";
    const result = await extractContentFromFile("blank-appendix.pdf", makePdf([
      textPage(textOnly), ...Array.from({ length: 6 }, (): FixturePage => ({ kind: "blank" })),
    ]));
    expect(result).toEqual({ text: textOnly });
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("recognizes a scanned sixth page without rendering the five selectable pages", async () => {
    const original = Array.from({ length: 5 }, (_, i) => `SELECTABLE ${i + 1}: original text.`);
    const last = "SCANNED SIXTH: still unverified.";
    const result = await extractContentFromFile("sixth-page.pdf", makePdf([...original.map(textPage), scanPage(last)]));
    expect(result).toEqual({ text: [...original, last].join("\n\n"), ocr: { engine: "vision", pageCount: 1, sourceType: "pdf" } });
    expect(callPages(mocks.vision.mock.calls)).toEqual([[6]]);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("accepts five nonadjacent scanned pages in a ten-page mixed PDF without renumbering", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => i % 2 === 0
      ? textPage(`SELECTABLE ${i + 1}: confirmed tasks.`)
      : scanPage(`SCANNED ${i + 1}: planned, not completed.`));
    const result = await extractContentFromFile("five-scanned-pages.pdf", makePdf(pages));
    expect(result).toEqual({
      text: pages.map(page => page.kind === "blank" ? "" : page.text).join("\n\n"),
      ocr: { engine: "vision", pageCount: 5, sourceType: "pdf" },
    });
    expect(callPages(mocks.vision.mock.calls)).toEqual([[2], [4], [6], [8], [10]]);
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("cancellation during a later OCR group (%s) keeps its cause and never falls back", async outcome => {
    mocks.mode = "auto";
    const controller = new AbortController();
    const reason = new Error("cancelled while reading mixed PDF");
    mocks.vision.mockImplementationOnce(async pages => recognizedText(pages)).mockImplementationOnce(async pages => {
      controller.abort(reason);
      if (outcome === "reject") throw new TypeError("late transport error");
      return recognizedText(pages);
    });
    await expect(extractContentFromFile("cancelled.pdf", makePdf([
      scanPage("SCANNED FIRST: valid."), textPage(textOnly), scanPage("SCANNED LAST: valid."),
    ]), { signal: controller.signal })).rejects.toBe(reason);
    expect(callPages(mocks.vision.mock.calls)).toEqual([[1], [3]]);
    expect(mocks.local).not.toHaveBeenCalled();
    await expect(extractContentFromFile("next.txt", Buffer.from("slot released"))).resolves.toEqual({ text: "slot released" });
  });

  it.each([0, 1])("checks the combined Unicode character budget at 200000 + %s", async extra => {
    const scanned = "\u{20000}".repeat(200_000 - [...textOnly].length - 2 + extra);
    expect([...textOnly, ..."\n\n", ...scanned]).toHaveLength(200_000 + extra);
    mocks.vision.mockResolvedValueOnce(scanned);
    const result = extractContentFromFile("combined-limit.pdf", makePdf([textPage(textOnly), scanPage("SCANNED: synthetic long OCR response.")]));
    if (extra) await expect(result).rejects.toThrow("PDF 提取文本不得超过 200000 字符");
    else expect((await result).text).toBe(`${textOnly}\n\n${scanned}`);
    expect(callPages(mocks.vision.mock.calls)).toEqual([[2]]);
  });

  it("rejects six nonblank scanned pages before any recognition instead of importing only five", async () => {
    const pages = [textPage(textOnly), ...Array.from({ length: 6 }, (_, index) => scanPage(`SCANNED PAGE ${index + 2}: preserve all pages.`))];
    await expect(extractContentFromFile("too-many-scans.pdf", makePdf(pages))).rejects.toThrow(/5.*页|页.*5/);
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });
});
