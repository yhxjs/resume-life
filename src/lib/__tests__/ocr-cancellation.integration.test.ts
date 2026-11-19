import { beforeEach, describe, expect, it, vi } from "vitest";
import { recognizeImage, recognizeScannedPdf } from "../ocr-service";
import type { OcrMode } from "../settings";

const mocks = vi.hoisted(() => ({ mode: "auto" as OcrMode, render: vi.fn(), image: vi.fn(), vision: vi.fn(), local: vi.fn(), log: vi.fn() }));
vi.mock("../settings", () => ({ readSettings: () => ({ ocr_mode: mocks.mode }) }));
vi.mock("../pdf-to-images", () => ({ MAX_OCR_PAGES: 5, renderPdfPagesToImages: mocks.render, processImageBufferToPage: mocks.image }));
vi.mock("../ocr-vision", () => ({ ocrPdfPagesWithVision: mocks.vision }));
vi.mock("../ocr-local", () => ({ ocrPdfPagesLocally: mocks.local }));
vi.mock("../server-errors", () => ({ logServerEvent: mocks.log }));

const page = { pageNumber: 1, hasVisualContent: true };
const input = Buffer.from("synthetic image or PDF");
const cancelled = () => new DOMException("Synthetic user cancellation", "AbortError");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.mode = "auto";
  mocks.render.mockResolvedValue([page]);
  mocks.image.mockResolvedValue(page);
  mocks.vision.mockResolvedValue("有效视觉结果");
  mocks.local.mockResolvedValue("有效本地结果");
});

describe.each([
  { label: "图片", recognize: recognizeImage, prepare: mocks.image },
  { label: "扫描 PDF", recognize: recognizeScannedPdf, prepare: mocks.render },
])("$label OCR 的取消边界", ({ recognize, prepare }) => {
  it.each(["auto", "vision", "local"] as const)("%s 已取消请求不开始图像准备或识别", async mode => {
    mocks.mode = mode;
    const reason = cancelled();
    await expect(recognize(input, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(prepare).not.toHaveBeenCalled();
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["reject", "resolve"] as const)("准备阶段取消且任务迟到 %s 时保留取消原因", async outcome => {
    const controller = new AbortController();
    const reason = new Error("Synthetic preparation cancellation");
    prepare.mockImplementationOnce(async () => {
      controller.abort(reason);
      if (outcome === "reject") throw new TypeError("Late preparation error");
      return prepare === mocks.image ? page : [page];
    });
    await expect(recognize(input, controller.signal)).rejects.toBe(reason);
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("准备阶段 AbortError 原样传递，不包装成文件格式错误", async () => {
    const reason = cancelled();
    prepare.mockRejectedValueOnce(reason);
    await expect(recognize(input)).rejects.toBe(reason);
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it.each(["reject", "resolve"] as const)("auto 视觉等待时取消且迟到 %s 不降级、不返回结果", async outcome => {
    const pending = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("Synthetic request cancellation");
    mocks.vision.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
    const result = recognize(input, controller.signal);
    const rejected = expect(result).rejects.toBe(reason);
    await started.promise;
    expect(mocks.vision.mock.calls[0]?.[1]).toBe(controller.signal);
    controller.abort(reason);
    if (outcome === "reject") pending.reject(new TypeError("Late network failure"));
    else pending.resolve("迟到的有效视觉结果");
    await rejected;
    expect(mocks.local).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
    // 新请求仍可正常执行，不沿用已取消状态。
    expect(await recognize(input, new AbortController().signal)).toMatchObject({ text: "有效视觉结果", engine: "vision" });
  });

  it("auto 视觉 AbortError 不记录降级或调用本地", async () => {
    const reason = cancelled();
    mocks.vision.mockRejectedValueOnce(reason);
    await expect(recognize(input)).rejects.toBe(reason);
    expect(mocks.local).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it.each((["vision", "local", "auto"] as const).flatMap(mode =>
    (["resolve", "reject"] as const).map(outcome => ({ mode, outcome }))))("$mode 识别期间取消后迟到 $outcome 保留取消原因", async ({ mode, outcome }) => {
    mocks.mode = mode;
    const controller = new AbortController();
    const reason = cancelled();
    const engine = mode === "vision" ? mocks.vision : mocks.local;
    if (mode === "auto") mocks.vision.mockRejectedValueOnce(new TypeError("Synthetic network failure"));
    engine.mockImplementationOnce(async () => {
      controller.abort(reason);
      if (outcome === "reject") throw new TypeError("Late OCR failure");
      return "迟到结果";
    });
    await expect(recognize(input, controller.signal)).rejects.toBe(reason);
  });

  it("auto 视觉自身超时且请求仍有效时继续本地降级", async () => {
    const controller = new AbortController();
    mocks.vision.mockRejectedValueOnce(new DOMException("Synthetic provider timeout", "TimeoutError"));
    expect(await recognize(input, controller.signal)).toMatchObject({ text: "有效本地结果", engine: "local" });
    expect(mocks.local).toHaveBeenCalledWith([page], { signal: controller.signal });
    expect(mocks.log).toHaveBeenCalledWith("warn", "ocr.vision_fallback_to_local", { context: { errorCode: "timeout", pageCount: 1 } });
  });
});
