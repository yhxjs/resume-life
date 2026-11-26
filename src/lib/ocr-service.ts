import { readSettings, type OcrMode } from "./settings";
import { renderPdfPagesToImages, processImageBufferToPage, MAX_OCR_PAGES, type PdfPageImage } from "./pdf-to-images";
import { ocrPdfPagesWithVision } from "./ocr-vision";
import { ocrPdfPagesLocally } from "./ocr-local";
import { FileFormatError } from "./parse-sandbox";
import { logServerEvent } from "./server-errors";
import { LlmConfigError } from "./llm";
import { LlmResponseError } from "./llm-adapter";
import { hasOcrText } from "./ocr-output";

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
async function runOcrPipeline<T>(
  pageCount: number,
  mode: OcrMode,
  recognize: (engine: "vision" | "local") => Promise<T>,
  signal?: AbortSignal
): Promise<{ value: T; engine: "vision" | "local" }> {
  signal?.throwIfAborted();
  let value: T;
  let engine: "vision" | "local" = "local";

  try {
    if (mode === "vision") {
      value = await recognize("vision");
      engine = "vision";
    } else if (mode === "local") {
      value = await recognize("local");
      engine = "local";
    } else {
      // auto: 优先视觉大模型，失败自动平滑降级到本地离线 OCR
      try {
        value = await recognize("vision");
        engine = "vision";
      } catch (visionError) {
        signal?.throwIfAborted();
        if (visionError instanceof Error && visionError.name === "AbortError") throw visionError;
        logServerEvent("warn", "ocr.vision_fallback_to_local", {
          context: {
            errorCode: fallbackErrorCode(visionError, signal),
            pageCount,
          },
        });
        value = await recognize("local");
        engine = "local";
      }
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }

  signal?.throwIfAborted();
  return { value, engine };
}

async function recognizePages(engine: "vision" | "local", pages: PdfPageImage[], signal?: AbortSignal): Promise<string> {
  return (await (engine === "vision" ? ocrPdfPagesWithVision(pages, signal) : ocrPdfPagesLocally(pages, { signal }))).trim();
}

/** 仅识别混合 PDF 中缺少文字层的非空页，按原位置补回；文字层不重新识别。 */
export async function recognizeMixedPdf(
  pdfBuffer: Buffer,
  pageTexts: string[],
  pageNumbers: number[],
  signal?: AbortSignal,
  modeOverride?: OcrMode
): Promise<{ text: string; engine: "vision" | "local" | null; pageCount: number }> {
  signal?.throwIfAborted();
  // 只渲染缺少文字层且可能有图形的页，原页号与整批像素/页数预算仍受校验。
  const pages = await renderPdfPagesToImages(pdfBuffer, MAX_OCR_PAGES, signal, pageNumbers);
  signal?.throwIfAborted();
  if (pages.length !== pageNumbers.length) throw new FileFormatError("PDF 页数与提取结果不一致，请重新导入");
  const pagesByNumber = new Map(pages.map(page => [page.pageNumber, page]));

  const groups: { start: number; pages: PdfPageImage[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const [index, text] of pageTexts.entries()) {
    if (text.trim()) { current = undefined; continue; }
    const page = pagesByNumber.get(index + 1);
    if (!page?.hasVisualContent) continue;
    if (!current) {
      current = { start: index, pages: [] };
      groups.push(current);
    }
    current.pages.push(page);
  }
  if (!groups.length) return { text: pageTexts.join("\n\n").trim(), engine: null, pageCount: 0 };

  const mode = modeOverride ?? (readSettings().ocr_mode || "auto") as OcrMode;
  if (mode === "off") {
    throw new FileFormatError("PDF 部分页面没有可选文字，系统当前已关闭 OCR 识别。请开启 OCR 或上传完整的文字版 PDF。");
  }
  const pageCount = groups.reduce((count, group) => count + group.pages.length, 0);
  const result = await runOcrPipeline(pageCount, mode, async (engine) => {
    const extracted: string[] = [];
    for (const group of groups) {
      signal?.throwIfAborted();
      const text = await recognizePages(engine, group.pages, signal);
      signal?.throwIfAborted();
      if (!hasOcrText(text)) {
        throw new LlmResponseError(`PDF 第 ${group.pages.map(page => page.pageNumber).join("、")} 页未识别出有效文字，请检查页面或上传文字版 PDF`, "protocol");
      }
      extracted.push(text);
    }
    return extracted;
  }, signal);
  const merged = [...pageTexts];
  groups.forEach((group, index) => { merged[group.start] = result.value[index]!; });
  return { text: merged.filter(text => text.trim()).join("\n\n").trim(), engine: result.engine, pageCount };
}

/**
 * 对扫描版 PDF 页面执行 OCR 提取，遵循系统设置中的 ocr_mode 策略
 */
export async function recognizeScannedPdf(
  pdfBuffer: Buffer,
  signal?: AbortSignal,
  reason: "scanned" | "requested" = "scanned",
  modeOverride?: OcrMode
): Promise<OcrServiceResult> {
  signal?.throwIfAborted();
  const mode = modeOverride ?? (readSettings().ocr_mode || "auto") as OcrMode;

  if (mode === "off") {
    throw new FileFormatError(
      reason === "requested"
        ? "按页面图片识别需要 OCR，系统当前已关闭 OCR。请在「系统设置」开启 OCR，或取消按页面图片识别后重试。"
        : "PDF 文件未包含可选中文本（扫描件），系统当前已关闭 OCR 识别。请上传文字版 PDF 或前往「系统设置」开启扫描件 OCR。"
    );
  }

  // 超过 MAX_OCR_PAGES 页时渲染器明确拒绝，避免静默遗漏后续页面。
  let pages: PdfPageImage[];
  try {
    pages = await renderPdfPagesToImages(pdfBuffer, MAX_OCR_PAGES, signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
  signal?.throwIfAborted();
  if (!pages.length || !pages.some((p) => p.hasVisualContent)) {
    throw new FileFormatError(
      reason === "requested" ? "PDF 页面图片未包含有效内容，请检查文件或使用文字提取"
        : "PDF 文件未包含可选中文本（可能为图片扫描件或未内嵌字体的打印件），请使用文字版 PDF、Word 或复制纯文本导入"
    );
  }

  const result = await runOcrPipeline(pages.length, mode, engine => recognizePages(engine, pages, signal), signal);
  if (!hasOcrText(result.value)) {
    throw new FileFormatError(
      reason === "requested" ? "未能从 PDF 页面图片中识别出有效文字，请检查文件或使用文字提取"
        : "PDF 文件未包含可选中文本（可能为图片扫描件或未内嵌字体的打印件），请使用文字版 PDF、Word 或复制纯文本导入"
    );
  }

  return {
    text: result.value,
    engine: result.engine,
    pageCount: pages.length,
  };
}

/**
 * 对上传的单张图片执行 OCR 提取，遵循系统设置中的 ocr_mode 策略
 */
export async function recognizeImage(
  imageBuffer: Buffer,
  signal?: AbortSignal,
  modeOverride?: OcrMode
): Promise<OcrServiceResult> {
  signal?.throwIfAborted();
  const mode = modeOverride ?? (readSettings().ocr_mode || "auto") as OcrMode;

  if (mode === "off") {
    throw new FileFormatError(
      "图片文件需通过 OCR 识别提取文本，系统当前已关闭 OCR 识别。请前往「系统设置」开启 OCR 或复制纯文本导入。"
    );
  }

  let pageImage: PdfPageImage;
  try {
    pageImage = await processImageBufferToPage(imageBuffer, signal);
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new FileFormatError(
      err instanceof Error ? err.message : "图片文件损坏或不支持该格式"
    );
  }

  signal?.throwIfAborted();
  if (!pageImage.hasVisualContent) {
    throw new FileFormatError("图片未包含有效笔迹或内容，请上传清晰的简历图片");
  }

  const result = await runOcrPipeline(1, mode, engine => recognizePages(engine, [pageImage], signal), signal);
  if (!hasOcrText(result.value)) {
    throw new FileFormatError("未能从图片中识别出有效文字，请确认图片清晰度或尝试复制纯文本导入");
  }

  return {
    text: result.value,
    engine: result.engine,
    pageCount: 1,
  };
}
