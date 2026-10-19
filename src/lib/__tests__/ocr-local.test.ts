import { describe, it, expect, vi, beforeEach } from "vitest";
import { ocrPdfPagesLocally } from "../ocr-local";
import type { PdfPageImage } from "../pdf-to-images";

describe("ocr-local.ts 本地离线 OCR", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("当页面列表为空时，立即返回空字符串，不初始化 worker", async () => {
    const text = await ocrPdfPagesLocally([]);
    expect(text).toBe("");
  });

  it("所需语言初始化失败时保留原因并明确报错，不降级为英文成功结果", async () => {
    const cause = new Error("corrupt chi_sim data");
    const createWorker = vi.fn()
      .mockRejectedValueOnce(cause)
      .mockResolvedValue({ recognize: async () => ({ data: { text: "wrong English result" } }), terminate: async () => undefined });
    vi.doMock("tesseract.js", () => ({ createWorker }));
    const page: PdfPageImage = { pageNumber: 1, buffer: Buffer.from("fake-img"), base64: "", width: 1, height: 1, hasVisualContent: true };

    await expect(ocrPdfPagesLocally([page])).rejects.toMatchObject({
      message: expect.stringMatching(/本地 OCR.*初始化失败.*chi_sim\+eng/), cause,
    });
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("显式选择英文时正常识别并清理 worker", async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const createWorker = vi.fn().mockResolvedValue({ recognize: async () => ({ data: { text: "English text" } }), terminate });
    vi.doMock("tesseract.js", () => ({ createWorker }));
    const page: PdfPageImage = { pageNumber: 1, buffer: Buffer.from("fake-img"), base64: "", width: 1, height: 1, hasVisualContent: true };

    await expect(ocrPdfPagesLocally([page], { lang: "eng" })).resolves.toBe("English text");
    expect(createWorker).toHaveBeenCalledWith("eng", undefined, expect.anything());
    expect(terminate).toHaveBeenCalledOnce();
  });

  it.each(["abort", "timeout"] as const)("%s 后初始化失败不会重新打开 worker", async (stop) => {
    let rejectWorker!: (error: Error) => void;
    const createWorker = vi.fn(() => new Promise((_, reject) => { rejectWorker = reject; }));
    vi.doMock("tesseract.js", () => ({ createWorker }));
    const page: PdfPageImage = { pageNumber: 1, buffer: Buffer.from("fake-img"), base64: "", width: 1, height: 1, hasVisualContent: true };
    const controller = new AbortController();
    const result = ocrPdfPagesLocally([page], { signal: controller.signal, timeoutMs: stop === "timeout" ? 20 : 1_000 });
    const rejected = expect(result).rejects.toThrow(stop === "timeout" ? /超时/ : /cancelled/);
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledOnce());
    if (stop === "abort") controller.abort(new Error("cancelled"));
    await rejected;
    rejectWorker(new Error("initialization failed after stop"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("支持单页与多页识别，并能正确终止 worker 释放内存", async () => {
    const fakePages: PdfPageImage[] = [
      {
        pageNumber: 1,
        buffer: Buffer.from("fake-img-1"),
        base64: "data:image/png;base64,ZmFrZQ==",
        width: 100,
        height: 100,
        hasVisualContent: true,
      },
      {
        pageNumber: 2,
        buffer: Buffer.from("fake-img-2"),
        base64: "data:image/png;base64,ZmFrZQ==",
        width: 100,
        height: 100,
        hasVisualContent: true,
      },
    ];

    const mockRecognize = vi.fn()
      .mockResolvedValueOnce({ data: { text: "第一页内容：张三 工程师" } })
      .mockResolvedValueOnce({ data: { text: "第二页内容：项目经验与教育背景" } });
    const mockTerminate = vi.fn().mockResolvedValue(undefined);

    vi.doMock("tesseract.js", () => ({
      createWorker: vi.fn().mockResolvedValue({
        recognize: mockRecognize,
        terminate: mockTerminate,
      }),
    }));

    const { ocrPdfPagesLocally: mockedOcr } = await import("../ocr-local");
    const result = await mockedOcr(fakePages);

    expect(result).toContain("第一页内容：张三 工程师");
    expect(result).toContain("第二页内容：项目经验与教育背景");
    expect(mockRecognize).toHaveBeenCalledTimes(2);
    expect(mockTerminate).toHaveBeenCalledOnce();
  });

  it("触发超时时拒绝并抛出友好错误提示", async () => {
    const fakePages: PdfPageImage[] = [
      {
        pageNumber: 1,
        buffer: Buffer.from("fake-img"),
        base64: "data:image/png;base64,ZmFrZQ==",
        width: 100,
        height: 100,
        hasVisualContent: true,
      },
    ];

    vi.doMock("tesseract.js", () => ({
      createWorker: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      ),
    }));

    const { ocrPdfPagesLocally: mockedOcr } = await import("../ocr-local");
    await expect(mockedOcr(fakePages, { timeoutMs: 20 })).rejects.toThrow("超时");
  });

  it("超时后迟到的 worker 会终止，且不会继续识别", async () => {
    const page: PdfPageImage = {
      pageNumber: 1, buffer: Buffer.from("fake-img"), base64: "", width: 100, height: 100, hasVisualContent: true,
    };
    const recognize = vi.fn().mockResolvedValue({ data: { text: "迟到结果" } });
    const terminate = vi.fn().mockResolvedValue(undefined);
    let resolveWorker!: (value: { recognize: typeof recognize; terminate: typeof terminate }) => void;
    vi.doMock("tesseract.js", () => ({
      createWorker: vi.fn(() => new Promise((resolve) => { resolveWorker = resolve; })),
    }));

    await expect(ocrPdfPagesLocally([page], { timeoutMs: 20 })).rejects.toThrow("超时");
    resolveWorker({ recognize, terminate });
    await new Promise((resolve) => setImmediate(resolve));

    expect(recognize).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("识别成功后清理全部超时定时器", async () => {
    const page: PdfPageImage = {
      pageNumber: 1, buffer: Buffer.from("fake-img"), base64: "", width: 100, height: 100, hasVisualContent: true,
    };
    vi.doMock("tesseract.js", () => ({
      createWorker: vi.fn().mockResolvedValue({
        recognize: vi.fn().mockResolvedValue({ data: { text: "成功" } }),
        terminate: vi.fn().mockResolvedValue(undefined),
      }),
    }));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(ocrPdfPagesLocally([page], { timeoutMs: 1_000 })).resolves.toBe("成功");

    const scheduled = setTimeoutSpy.mock.results.map((result) => result.value);
    expect(scheduled.length).toBeGreaterThan(0);
    for (const timer of scheduled) {
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    }
  });
});
