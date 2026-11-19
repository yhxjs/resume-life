import { beforeEach, describe, expect, it, vi } from "vitest";
import { recognizeImage, recognizeScannedPdf } from "../ocr-service";
import { LlmResponseError } from "../llm-adapter";
import type { OcrMode } from "../settings";

const mocks = vi.hoisted(() => ({ mode: "auto" as OcrMode, vision: vi.fn(), local: vi.fn() }));
vi.mock("../settings", () => ({ readSettings: () => ({ ocr_mode: mocks.mode }) }));
vi.mock("../safe-llm", async original => ({
  ...await original<typeof import("../safe-llm")>(), safeVisionChat: mocks.vision,
}));
vi.mock("../ocr-local", () => ({ ocrPdfPagesLocally: mocks.local }));
vi.mock("../pdf-to-images", () => {
  const page = { pageNumber: 1, base64: "data:image/png;base64,c3ludGhldGlj", hasVisualContent: true };
  return { MAX_OCR_PAGES: 5, renderPdfPagesToImages: async () => [page], processImageBufferToPage: async () => page };
});

const placeholders = [
  { label: "空白", text: " \r\n\t " },
  { label: "纯标点", text: "，。？！…—_[]" },
  { label: "零宽字符", text: "\u200b\u200c\u200d\u2060" },
  { label: "控制字符", text: "\u0000\u0007\u001b" },
  { label: "孤立组合标记", text: "\u0301\u20dd" },
  { label: "不可见字母填充符", text: "\u115f\u1160\u3164\uffa0" },
];
const validText = "张三\nCafe\u0301 API / C++ 👩\u200d💻\nمی\u200cرود 2024\n未上线\u200b，收益未知。";
const input = Buffer.from("synthetic image or PDF");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode = "auto";
  mocks.local.mockResolvedValue(validText);
});

describe.each([
  { label: "图片", recognize: recognizeImage },
  { label: "扫描 PDF", recognize: recognizeScannedPdf },
])("$label 的 OCR 输出内容", ({ recognize }) => {
  it.each(placeholders)("视觉仅返回$label时 auto 降级，合法重试恢复视觉引擎", async ({ text }) => {
    mocks.vision.mockResolvedValueOnce(text).mockResolvedValueOnce(` \n${validText}\t `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await recognize(input)).toEqual({ text: validText, engine: "local", pageCount: 1 });
      expect(mocks.local).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('"errorCode":"protocol"');
      expect(await recognize(input)).toEqual({ text: validText, engine: "vision", pageCount: 1 });
      expect(mocks.local).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it.each(placeholders)("显式 vision 仅返回$label时拒绝，无本地调用且可重试", async ({ text }) => {
    mocks.mode = "vision";
    mocks.vision.mockResolvedValueOnce(text).mockResolvedValueOnce(validText);
    await expect(recognize(input)).rejects.toMatchObject({ code: "protocol" });
    expect(mocks.local).not.toHaveBeenCalled();
    expect(await recognize(input)).toEqual({ text: validText, engine: "vision", pageCount: 1 });
  });

  it.each(placeholders)("本地仅返回$label时拒绝，不作为导入正文", async ({ text }) => {
    mocks.mode = "local";
    mocks.local.mockResolvedValueOnce(text).mockResolvedValueOnce(validText);
    await expect(recognize(input)).rejects.toThrow();
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(await recognize(input)).toEqual({ text: validText, engine: "local", pageCount: 1 });
  });

  it("auto 的两种引擎均无文字时拒绝，并保留已有降级路径", async () => {
    mocks.vision.mockRejectedValueOnce(new LlmResponseError("Synthetic failure", "protocol"));
    mocks.local.mockResolvedValueOnce("\u3164\u200b…");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try { await expect(recognize(input)).rejects.toThrow(); }
    finally { warn.mockRestore(); }
    expect(mocks.local).toHaveBeenCalledOnce();
  });

  it.each(["2026", "[无法辨认]", "C++ / C# / operator< / operator>", validText])("合法识别结果原样保留：%s", async text => {
    mocks.vision.mockResolvedValueOnce(` \n${text}\t `);
    expect(await recognize(input)).toEqual({ text, engine: "vision", pageCount: 1 });
    expect(mocks.local).not.toHaveBeenCalled();
  });
});
