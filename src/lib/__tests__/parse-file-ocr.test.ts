import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractTextFromFile, extractContentFromFile, PdfNoTextError } from "../parse-file";
import * as ocrService from "../ocr-service";
import * as sandbox from "../parse-sandbox";

vi.mock("../ocr-service", () => ({
  recognizeScannedPdf: vi.fn(),
  recognizeImage: vi.fn(),
  MAX_OCR_PAGES: 5,
}));

describe("parse-file.ts 扫描版 PDF 与图片 OCR 触发集成", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("当常规 PDF 提取抛出 PdfNoTextError（扫描件无可选中文本）时，自动触发 OCR 提取流程", async () => {
    vi.spyOn(sandbox, "runInSandboxedProcess").mockRejectedValueOnce(new PdfNoTextError());
    vi.mocked(ocrService.recognizeScannedPdf).mockResolvedValueOnce({
      text: "OCR 成功识别出简历正文：王五 前端架构师",
      engine: "vision",
      pageCount: 1,
    });

    const fakePdf = Buffer.from("scanned-pdf-data");
    const result = await extractTextFromFile("resume.pdf", fakePdf);

    expect(result).toBe("OCR 成功识别出简历正文：王五 前端架构师");
    expect(ocrService.recognizeScannedPdf).toHaveBeenCalledWith(fakePdf, undefined);
  });

  it("extractContentFromFile 会返回扫描件使用的 OCR 方法与页数", async () => {
    vi.spyOn(sandbox, "runInSandboxedProcess").mockRejectedValueOnce(new PdfNoTextError());
    vi.mocked(ocrService.recognizeScannedPdf).mockResolvedValueOnce({
      text: "OCR 成功识别出简历正文：李四 后端架构师",
      engine: "local",
      pageCount: 2,
    });

    const fakePdf = Buffer.from("scanned-pdf-data");
    const content = await extractContentFromFile("resume.pdf", fakePdf);

    expect(content.text).toBe("OCR 成功识别出简历正文：李四 后端架构师");
    expect(content.ocr).toEqual({
      engine: "local",
      pageCount: 2,
      sourceType: "pdf",
    });
  });

  it("上传图片文件（如 .png/.jpg）时自动调用 recognizeImage 并返回 sourceType='image'", async () => {
    vi.mocked(ocrService.recognizeImage).mockResolvedValueOnce({
      text: "图片 OCR 成功识别出简历：张三 算法工程师",
      engine: "vision",
      pageCount: 1,
    });

    const fakeImg = Buffer.from("image-bytes");
    const content = await extractContentFromFile("my_resume.png", fakeImg);

    expect(content.text).toBe("图片 OCR 成功识别出简历：张三 算法工程师");
    expect(content.ocr).toEqual({
      engine: "vision",
      pageCount: 1,
      sourceType: "image",
    });
    expect(ocrService.recognizeImage).toHaveBeenCalledWith(fakeImg, undefined);
  });

  it("若图片 OCR 识别后内容超出 MAX_TEXT_CHARS 限制，抛出超限错误", async () => {
    vi.mocked(ocrService.recognizeImage).mockResolvedValueOnce({
      text: "x".repeat(200_001),
      engine: "local",
      pageCount: 1,
    });

    const fakeImg = Buffer.from("image-bytes");
    await expect(extractContentFromFile("large.jpg", fakeImg)).rejects.toThrow("图片提取文本不得超过 200000 字符");
  });

  it("若 OCR 识别后内容超出 MAX_TEXT_CHARS 限制，抛出超限错误", async () => {
    vi.spyOn(sandbox, "runInSandboxedProcess").mockRejectedValueOnce(new PdfNoTextError());
    vi.mocked(ocrService.recognizeScannedPdf).mockResolvedValueOnce({
      text: "a".repeat(200_001),
      engine: "local",
      pageCount: 3,
    });

    const fakePdf = Buffer.from("scanned-pdf-data");
    await expect(extractTextFromFile("large.pdf", fakePdf)).rejects.toThrow("不得超过 200000 字符");
  });
});
