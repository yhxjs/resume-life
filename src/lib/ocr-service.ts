import { readSettings, type OcrMode } from "./settings";
import { renderPdfPagesToImages, processImageBufferToPage, MAX_OCR_PAGES, type PdfPageImage } from "./pdf-to-images";
import { ocrPdfPagesWithVision } from "./ocr-vision";
import { ocrPdfPagesLocally } from "./ocr-local";
import { FileFormatError } from "./parse-sandbox";
import { logServerEvent } from "./server-errors";
import { LlmConfigError } from "./llm";
import { LlmResponseError } from "./llm-adapter";

export { MAX_OCR_PAGES };

export type OcrServiceResult = {
  text: string;
  engine: "vision" | "local";
  pageCount: number;
};

function fallbackErrorCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled";
  if (error instanceof LlmConfigError) return "config";
  if (error instanceof LlmResponseError) return error.code;
  if (error instanceof TypeError) return "network";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? `http_${status}` : "unknown";
}

/**
 * 通用 OCR 双轨执行管线（遵循系统配置：vision / local / auto 降级）
 */
async function runOcrPipeline(
  pages: PdfPageImage[],
  mode: OcrMode,
  signal?: AbortSignal
): Promise<{ text: string; engine: "vision" | "local" }> {
  let text = "";
  let engine: "vision" | "local" = "local";

  if (mode === "vision") {
    text = await ocrPdfPagesWithVision(pages, signal);
    engine = "vision";
  } else if (mode === "local") {
    text = await ocrPdfPagesLocally(pages, { signal });
    engine = "local";
  } else {
    // auto: 优先视觉大模型，失败自动平滑降级到本地离线 OCR
    try {
      text = await ocrPdfPagesWithVision(pages, signal);
      engine = "vision";
    } catch (visionError) {
      logServerEvent("warn", "ocr.vision_fallback_to_local", {
        context: {
          errorCode: fallbackErrorCode(visionError, signal),
          pageCount: pages.length,
        },
      });
      text = await ocrPdfPagesLocally(pages, { signal });
      engine = "local";
    }
  }

  return { text: text.trim(), engine };
}

/**
 * 对扫描版 PDF 页面执行 OCR 提取，遵循系统设置中的 ocr_mode 策略
 */
export async function recognizeScannedPdf(
  pdfBuffer: Buffer,
  signal?: AbortSignal
): Promise<OcrServiceResult> {
  const settings = readSettings();
  const mode = (settings.ocr_mode || "auto") as OcrMode;

  if (mode === "off") {
    throw new FileFormatError(
      "PDF 文件未包含可选中文本（扫描件），系统当前已关闭 OCR 识别。请上传文字版 PDF 或前往「系统设置」开启扫描件 OCR。"
    );
  }

  // 超过 MAX_OCR_PAGES 页时渲染器明确拒绝，避免静默遗漏后续页面。
  const pages = await renderPdfPagesToImages(pdfBuffer, MAX_OCR_PAGES, signal);
  if (!pages.length || !pages.some((p) => p.hasVisualContent)) {
    throw new FileFormatError(
      "PDF 文件未包含可选中文本（可能为图片扫描件或未内嵌字体的打印件），请使用文字版 PDF、Word 或复制纯文本导入"
    );
  }

  const result = await runOcrPipeline(pages, mode, signal);
  if (!result.text) {
    throw new FileFormatError(
      "PDF 文件未包含可选中文本（可能为图片扫描件或未内嵌字体的打印件），请使用文字版 PDF、Word 或复制纯文本导入"
    );
  }

  return {
    text: result.text,
    engine: result.engine,
    pageCount: pages.length,
  };
}

/**
 * 对上传的单张图片执行 OCR 提取，遵循系统设置中的 ocr_mode 策略
 */
export async function recognizeImage(
  imageBuffer: Buffer,
  signal?: AbortSignal
): Promise<OcrServiceResult> {
  const settings = readSettings();
  const mode = (settings.ocr_mode || "auto") as OcrMode;

  if (mode === "off") {
    throw new FileFormatError(
      "图片文件需通过 OCR 识别提取文本，系统当前已关闭 OCR 识别。请前往「系统设置」开启 OCR 或复制纯文本导入。"
    );
  }

  let pageImage: PdfPageImage;
  try {
    pageImage = await processImageBufferToPage(imageBuffer, signal);
  } catch (err) {
    throw new FileFormatError(
      err instanceof Error ? err.message : "图片文件损坏或不支持该格式"
    );
  }

  if (!pageImage.hasVisualContent) {
    throw new FileFormatError("图片未包含有效笔迹或内容，请上传清晰的简历图片");
  }

  const result = await runOcrPipeline([pageImage], mode, signal);
  if (!result.text) {
    throw new FileFormatError("未能从图片中识别出有效文字，请确认图片清晰度或尝试复制纯文本导入");
  }

  return {
    text: result.text,
    engine: result.engine,
    pageCount: 1,
  };
}
