import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ocrPdfPagesLocally } from "../ocr-local";

const originalDirectory = process.cwd();
const page = { pageNumber: 1, buffer: Buffer.from("test"), base64: "", width: 1, height: 1, hasVisualContent: true };

afterEach(() => {
  process.chdir(originalDirectory);
  vi.unstubAllEnvs();
  vi.doUnmock("tesseract.js");
});

it("工作目录变更时仍使用显式离线语言包目录", async () => {
  const createWorker = vi.fn().mockResolvedValue({ recognize: async () => ({ data: { text: "ok" } }), terminate: async () => undefined });
  vi.doMock("tesseract.js", () => ({ createWorker }));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-ocr-cwd-"));
  vi.stubEnv("RESUME_LIFE_OCR_DATA_DIR", originalDirectory);
  try {
    process.chdir(temporary);
    await ocrPdfPagesLocally([page]);
    expect(createWorker).toHaveBeenCalledWith("chi_sim+eng", undefined, expect.objectContaining({
      langPath: originalDirectory, gzip: false, cacheMethod: "none",
    }));
  } finally {
    process.chdir(originalDirectory);
    fs.rmdirSync(temporary);
  }
});

it("语言包缺失时明确报错且不请求远端", async () => {
  const createWorker = vi.fn();
  vi.doMock("tesseract.js", () => ({ createWorker }));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-ocr-empty-"));
  vi.stubEnv("RESUME_LIFE_OCR_DATA_DIR", temporary);
  try {
    await expect(ocrPdfPagesLocally([page])).rejects.toThrow(/语言包/);
    expect(createWorker).not.toHaveBeenCalled();
  } finally {
    fs.rmdirSync(temporary);
  }
});

it("真实 worker 在工作目录改变后从本地加载中英文语言包", async () => {
  vi.doUnmock("tesseract.js");
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(500, 140);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 500, 140);
  context.fillStyle = "black";
  context.font = "bold 64px sans-serif";
  context.fillText("HELLO", 30, 95);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-ocr-real-"));
  vi.stubEnv("RESUME_LIFE_OCR_DATA_DIR", originalDirectory);
  try {
    process.chdir(temporary);
    const text = await ocrPdfPagesLocally([{ ...page, buffer: canvas.toBuffer("image/png") }], { timeoutMs: 60_000 });
    expect(text).toMatch(/HELLO/iu);
  } finally {
    process.chdir(originalDirectory);
    fs.rmdirSync(temporary);
  }
}, 90_000);
