import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { extractContentFromFile } from "../parse-file";
import { renderPdfPagesToImages, type PdfPageImage } from "../pdf-to-images";
import { ocrPdfPagesLocally } from "../ocr-local";

const mocks = vi.hoisted(() => ({
  mode: "local", createWorker: vi.fn(), recognize: vi.fn(), terminate: vi.fn(), vision: vi.fn(),
}));
vi.mock("tesseract.js", () => ({ createWorker: mocks.createWorker }));
vi.mock("../settings", () => ({ readSettings: () => ({ ocr_mode: mocks.mode }) }));
vi.mock("../ocr-vision", () => ({ ocrPdfPagesWithVision: mocks.vision }));

const first = "FIRST PAGE: IMPLEMENTED PARAMETER CHECKS";
const second = "SECOND PAGE: ONLY TESTED, NOT DEPLOYED";
const header = "SELECTABLE COVER";
let temporary: string;
let scanned: Buffer;
let mixed: Buffer;
let blank: Buffer;
let scannedPages: PdfPageImage[];

/** Real PDF and rasterization; only recognition and settings are substituted. */
function makePdf(kinds: ("first" | "second" | "blank" | "text")[]): Buffer {
  const stream = (bytes: Buffer, attrs = "") => Buffer.concat([
    Buffer.from(`<< /Length ${bytes.length} ${attrs} >>\nstream\n`), bytes, Buffer.from("\nendstream"),
  ]);
  const objects: Buffer[] = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.alloc(0)];
  const append = (value: Buffer | string) => objects.push(typeof value === "string" ? Buffer.from(value) : value);
  const fontId = append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = kinds.map(kind => {
    const pageId = append(Buffer.alloc(0));
    let resources = `<< /Font << /F1 ${fontId} 0 R >> >>`;
    let commands = `BT /F1 22 Tf 20 720 Td (${header}) Tj ET`;
    if (kind !== "text") {
      const canvas = createCanvas(600, 800);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, 600, 800);
      if (kind !== "blank") {
        ctx.fillStyle = "black"; ctx.font = "22px Arial";
        ctx.fillText(kind === "first" ? first : second, 20, 80);
      }
      const imageId = append(stream(canvas.toBuffer("image/jpeg"), "/Type /XObject /Subtype /Image /Width 600 /Height 800 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"));
      resources = `<< /XObject << /Im1 ${imageId} 0 R >> >>`;
      commands = "q 600 0 0 800 0 0 cm /Im1 Do Q";
    }
    const contentId = append(stream(Buffer.from(commands)));
    objects[pageId - 1] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources ${resources} /Contents ${contentId} 0 R >>`);
    return pageId;
  });
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${kinds.length} >>`);
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let offset = parts[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(part); offset += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
  return Buffer.concat(parts);
}

beforeAll(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-local-page-test-"));
  for (const language of ["eng", "chi_sim"]) fs.writeFileSync(path.join(temporary, `${language}.traineddata`), "synthetic worker file");
  vi.stubEnv("RESUME_LIFE_OCR_DATA_DIR", temporary);
  scanned = makePdf(["first", "second"]);
  mixed = makePdf(["text", "first", "second"]);
  blank = makePdf(["first", "blank"]);
  scannedPages = await renderPdfPagesToImages(scanned);
  expect(scannedPages.map(page => page.hasVisualContent)).toEqual([true, true]);
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode = "local";
  mocks.terminate.mockResolvedValue(undefined);
  mocks.createWorker.mockResolvedValue({ recognize: mocks.recognize, terminate: mocks.terminate });
});
afterAll(() => {
  vi.unstubAllEnvs();
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("resume-life-local-page-test-")) throw new Error("Unsafe fixture cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("local OCR cannot silently accept a missing nonblank page", () => {
  it.each(["scanned", "image", "mixed", "fallback"])("%s extraction rejects a missing page and terminates the worker", async mode => {
    if (mode === "fallback") {
      mocks.mode = "auto";
      mocks.vision.mockRejectedValue(new Error("synthetic vision failure"));
    }
    mocks.recognize.mockResolvedValueOnce({ data: { text: first } }).mockResolvedValueOnce({ data: { text: "" } });
    await expect(extractContentFromFile("source.pdf", mode === "mixed" ? mixed : scanned, mode === "image" ? { pdfMode: "image" } : undefined))
      .rejects.toThrow(`第 ${mode === "mixed" ? 3 : 2} 页未识别出有效文字`);
    expect(mocks.recognize).toHaveBeenCalledTimes(2);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(mocks.vision).toHaveBeenCalledTimes(mode === "fallback" ? 1 : 0);
  });

  it.each([" \n\t", "...，。", "\u200b\u3164"])("rejects unusable text %j on a visible second page", async text => {
    mocks.recognize.mockResolvedValueOnce({ data: { text: first } }).mockResolvedValueOnce({ data: { text } });
    await expect(ocrPdfPagesLocally(scannedPages)).rejects.toThrow("第 2 页未识别出有效文字");
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it("allows a genuinely blank page without inventing content", async () => {
    expect((await renderPdfPagesToImages(blank)).map(page => page.hasVisualContent)).toEqual([true, false]);
    mocks.recognize.mockResolvedValueOnce({ data: { text: first } }).mockResolvedValueOnce({ data: { text: "" } });
    await expect(extractContentFromFile("blank.pdf", blank, { pdfMode: "image" })).resolves.toEqual({
      text: first, ocr: { engine: "local", pageCount: 2, sourceType: "pdf" },
    });
    expect(mocks.terminate).toHaveBeenCalledOnce();
  });

  it("a new request after failure retains both pages and accepts an explicit unreadable marker", async () => {
    mocks.recognize.mockResolvedValueOnce({ data: { text: first } }).mockResolvedValueOnce({ data: { text: "" } });
    await expect(ocrPdfPagesLocally(scannedPages)).rejects.toThrow("第 2 页");
    mocks.recognize.mockResolvedValueOnce({ data: { text: first } }).mockResolvedValueOnce({ data: { text: `${second}; date: [无法辨认]` } });
    await expect(ocrPdfPagesLocally(scannedPages)).resolves.toBe(`${first}\n\n${second}; date: [无法辨认]`);
    expect(mocks.createWorker).toHaveBeenCalledTimes(2);
    expect(mocks.terminate).toHaveBeenCalledTimes(2);
  });
});
