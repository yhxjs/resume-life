import { describe, it, expect, vi, beforeEach } from "vitest";
import { recognizeScannedPdf, recognizeImage } from "../ocr-service";
import * as settingsMod from "../settings";
import * as pdfToImagesMod from "../pdf-to-images";
import * as ocrVisionMod from "../ocr-vision";
import * as ocrLocalMod from "../ocr-local";
import { LlmResponseError } from "../llm-adapter";

vi.mock("../settings", () => ({
  readSettings: vi.fn(),
}));

vi.mock("../pdf-to-images", () => ({
  MAX_OCR_PAGES: 5,
  renderPdfPagesToImages: vi.fn(),
  processImageBufferToPage: vi.fn(),
}));

vi.mock("../ocr-vision", () => ({
  ocrPdfPagesWithVision: vi.fn(),
}));

vi.mock("../ocr-local", () => ({
  ocrPdfPagesLocally: vi.fn(),
}));

describe("ocr-service.ts 双轨调度器", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const dummyPdfBuffer = Buffer.from("dummy-pdf");
  const dummyImageBuffer = Buffer.from("dummy-image");
  const dummyPages = [
    {
      pageNumber: 1,
      buffer: Buffer.from("img"),
      base64: "data:image/png;base64,abc",
      width: 100,
      height: 100,
      hasVisualContent: true,
    },
  ];

  it("当页面全为空白无图文时直接抛出友好错误提示", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "",
      api_key: "",
      api_format: "openai_chat",
      model_parse: "",
      model_summary: "",
      model_question: "",
      model_evaluate: "",
      ocr_mode: "auto",
    });
    vi.mocked(pdfToImagesMod.renderPdfPagesToImages).mockResolvedValueOnce([
      {
        pageNumber: 1,
        buffer: Buffer.from("blank"),
        base64: "data:image/png;base64,blank",
        width: 100,
        height: 100,
        hasVisualContent: false,
      },
    ]);

    await expect(recognizeScannedPdf(dummyPdfBuffer)).rejects.toThrow("PDF 文件未包含可选中文本");
    expect(ocrVisionMod.ocrPdfPagesWithVision).not.toHaveBeenCalled();
    expect(ocrLocalMod.ocrPdfPagesLocally).not.toHaveBeenCalled();
  });

  it("当系统设置 ocr_mode='off' 时拒绝并提示开启 OCR", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "",
      api_key: "",
      api_format: "openai_chat",
      model_parse: "",
      model_summary: "",
      model_question: "",
      model_evaluate: "",
      ocr_mode: "off",
    });

    await expect(recognizeScannedPdf(dummyPdfBuffer)).rejects.toThrow("关闭 OCR");
    expect(pdfToImagesMod.renderPdfPagesToImages).not.toHaveBeenCalled();
  });

  it("当 mode='local' 时直接调用本地离线 OCR", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "",
      api_key: "",
      api_format: "openai_chat",
      model_parse: "",
      model_summary: "",
      model_question: "",
      model_evaluate: "",
      ocr_mode: "local",
    });
    vi.mocked(pdfToImagesMod.renderPdfPagesToImages).mockResolvedValueOnce(dummyPages);
    vi.mocked(ocrLocalMod.ocrPdfPagesLocally).mockResolvedValueOnce("本地识别出的文字");

    const result = await recognizeScannedPdf(dummyPdfBuffer);
    expect(result.text).toBe("本地识别出的文字");
    expect(result.engine).toBe("local");
    expect(ocrVisionMod.ocrPdfPagesWithVision).not.toHaveBeenCalled();
    expect(ocrLocalMod.ocrPdfPagesLocally).toHaveBeenCalledOnce();
  });

  it("扫描件渲染阶段接收请求取消信号", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "", api_key: "", api_format: "openai_chat", model_parse: "",
      model_summary: "", model_question: "", model_evaluate: "", ocr_mode: "local",
    });
    vi.mocked(pdfToImagesMod.renderPdfPagesToImages).mockResolvedValueOnce(dummyPages);
    vi.mocked(ocrLocalMod.ocrPdfPagesLocally).mockResolvedValueOnce("识别结果");
    const signal = new AbortController().signal;

    await recognizeScannedPdf(dummyPdfBuffer, signal);

    expect(pdfToImagesMod.renderPdfPagesToImages).toHaveBeenCalledWith(dummyPdfBuffer, pdfToImagesMod.MAX_OCR_PAGES, signal);
  });

  it("当 mode='vision' 时调用多模态视觉模型", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "",
      api_key: "",
      api_format: "openai_chat",
      model_parse: "",
      model_summary: "",
      model_question: "",
      model_evaluate: "",
      ocr_mode: "vision",
    });
    vi.mocked(pdfToImagesMod.renderPdfPagesToImages).mockResolvedValueOnce(dummyPages);
    vi.mocked(ocrVisionMod.ocrPdfPagesWithVision).mockResolvedValueOnce("视觉大模型识别出的文字");

    const result = await recognizeScannedPdf(dummyPdfBuffer);
    expect(result.text).toBe("视觉大模型识别出的文字");
    expect(result.engine).toBe("vision");
    expect(ocrVisionMod.ocrPdfPagesWithVision).toHaveBeenCalledOnce();
    expect(ocrLocalMod.ocrPdfPagesLocally).not.toHaveBeenCalled();
  });

  it("当 mode='auto' 时，视觉模型成功直接返回，不走本地", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "",
      api_key: "",
      api_format: "openai_chat",
      model_parse: "",
      model_summary: "",
      model_question: "",
      model_evaluate: "",
      ocr_mode: "auto",
    });
    vi.mocked(pdfToImagesMod.renderPdfPagesToImages).mockResolvedValueOnce(dummyPages);
    vi.mocked(ocrVisionMod.ocrPdfPagesWithVision).mockResolvedValueOnce("auto 模式下视觉模型识别成功");

    const result = await recognizeScannedPdf(dummyPdfBuffer);
    expect(result.text).toBe("auto 模式下视觉模型识别成功");
    expect(result.engine).toBe("vision");
    expect(ocrVisionMod.ocrPdfPagesWithVision).toHaveBeenCalledOnce();
    expect(ocrLocalMod.ocrPdfPagesLocally).not.toHaveBeenCalled();
  });

  it("当 mode='auto' 且视觉模型报错时，自动无缝降级到本地离线 OCR", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "",
      api_key: "",
      api_format: "openai_chat",
      model_parse: "",
      model_summary: "",
      model_question: "",
      model_evaluate: "",
      ocr_mode: "auto",
    });
    vi.mocked(pdfToImagesMod.renderPdfPagesToImages).mockResolvedValueOnce(dummyPages);
    vi.mocked(ocrVisionMod.ocrPdfPagesWithVision).mockRejectedValueOnce(
      new LlmResponseError("PRIVATE_RESUME_TEXT sk-private-key", "protocol")
    );
    vi.mocked(ocrLocalMod.ocrPdfPagesLocally).mockResolvedValueOnce("降级后本地 Tesseract 成功提取");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof recognizeScannedPdf>>;
    let line = "";
    try {
      result = await recognizeScannedPdf(dummyPdfBuffer);
      line = String(warn.mock.calls[0]?.[0]);
    } finally {
      warn.mockRestore();
    }
    expect(result.text).toBe("降级后本地 Tesseract 成功提取");
    expect(result.engine).toBe("local");
    expect(ocrVisionMod.ocrPdfPagesWithVision).toHaveBeenCalledOnce();
    expect(ocrLocalMod.ocrPdfPagesLocally).toHaveBeenCalledOnce();
    expect(JSON.parse(line.replace(/^\[server-warn\]\s*/, ""))).toMatchObject({
      operation: "ocr.vision_fallback_to_local",
      context: { errorCode: "protocol", pageCount: 1 },
    });
    expect(line).not.toMatch(/PRIVATE_RESUME_TEXT|sk-private-key|reason/);
  });

  it("当提取出的文本为空字符串时抛出 FileFormatError", async () => {
    vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
      base_url: "",
      api_key: "",
      api_format: "openai_chat",
      model_parse: "",
      model_summary: "",
      model_question: "",
      model_evaluate: "",
      ocr_mode: "local",
    });
    vi.mocked(pdfToImagesMod.renderPdfPagesToImages).mockResolvedValueOnce(dummyPages);
    vi.mocked(ocrLocalMod.ocrPdfPagesLocally).mockResolvedValueOnce("   \n  ");

    await expect(recognizeScannedPdf(dummyPdfBuffer)).rejects.toThrow("PDF 文件未包含可选中文本");
  });

  describe("recognizeImage 单张图片 OCR 识别", () => {
    it("ocr_mode='off' 时拒绝并提示开启 OCR", async () => {
      vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
        base_url: "",
        api_key: "",
        api_format: "openai_chat",
        model_parse: "",
        model_summary: "",
        model_question: "",
        model_evaluate: "",
        ocr_mode: "off",
      });

      await expect(recognizeImage(dummyImageBuffer)).rejects.toThrow("系统当前已关闭 OCR 识别");
      expect(pdfToImagesMod.processImageBufferToPage).not.toHaveBeenCalled();
    });

    it("图片无有效像素内容时抛出友好提示", async () => {
      vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
        base_url: "",
        api_key: "",
        api_format: "openai_chat",
        model_parse: "",
        model_summary: "",
        model_question: "",
        model_evaluate: "",
        ocr_mode: "auto",
      });
      vi.mocked(pdfToImagesMod.processImageBufferToPage).mockResolvedValueOnce({
        pageNumber: 1,
        buffer: Buffer.from("blank"),
        base64: "data:image/png;base64,blank",
        width: 100,
        height: 100,
        hasVisualContent: false,
      });

      await expect(recognizeImage(dummyImageBuffer)).rejects.toThrow("图片未包含有效笔迹或内容");
    });

    it("成功通过视觉大模型识别图片文字并返回 pageCount=1", async () => {
      vi.mocked(settingsMod.readSettings).mockReturnValue({
      proxy_enabled: false, proxy_url: "", proxy_username: "", proxy_password: "", max_output_tokens: "8192",
        base_url: "",
        api_key: "",
        api_format: "openai_chat",
        model_parse: "",
        model_summary: "",
        model_question: "",
        model_evaluate: "",
        ocr_mode: "vision",
      });
      vi.mocked(pdfToImagesMod.processImageBufferToPage).mockResolvedValueOnce(dummyPages[0]!);
      vi.mocked(ocrVisionMod.ocrPdfPagesWithVision).mockResolvedValueOnce("图片中的简历正文内容");

      const res = await recognizeImage(dummyImageBuffer);
      expect(res.text).toBe("图片中的简历正文内容");
      expect(res.engine).toBe("vision");
      expect(res.pageCount).toBe(1);
    });
  });
});
