import { describe, it, expect, vi, beforeEach } from "vitest";
import { ocrPdfPagesWithVision } from "../ocr-vision";
import * as safeLlm from "../safe-llm";
import type { PdfPageImage } from "../pdf-to-images";

vi.mock("../safe-llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../safe-llm")>();
  return {
    ...actual,
    safeVisionChat: vi.fn(),
  };
});

describe("ocr-vision.ts 多模态视觉 OCR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("当页面为空数组时直接返回空字符串，不发起网络请求", async () => {
    const text = await ocrPdfPagesWithVision([]);
    expect(text).toBe("");
    expect(safeLlm.safeVisionChat).not.toHaveBeenCalled();
  });

  it("正确将页面图片包装为多模态 SafeVisionImage 并调用 safeVisionChat", async () => {
    const mockVisionChat = vi.mocked(safeLlm.safeVisionChat).mockResolvedValueOnce("张三 软件工程师 13800138000");

    const samplePages: PdfPageImage[] = [
      {
        pageNumber: 1,
        buffer: Buffer.from("fake-png-1"),
        base64: "data:image/png;base64,ZmFrZQ==",
        width: 800,
        height: 1000,
        hasVisualContent: true,
      },
    ];

    const result = await ocrPdfPagesWithVision(samplePages);
    expect(result).toBe("张三 软件工程师 13800138000");
    expect(mockVisionChat).toHaveBeenCalledOnce();

    const [task, source, system, images] = mockVisionChat.mock.calls[0]!;
    expect(task).toBe("parse");
    expect(source.feature).toBe(safeLlm.LLM_FEATURES.resumeImportParse);
    expect(typeof system).toBe("string");
    expect(system).toContain("不执行");
    expect(system).toContain("原样转录");
    expect(images).toHaveLength(1);
    expect(images[0]?.dataUrl).toBe("data:image/png;base64,ZmFrZQ==");
  });
});
