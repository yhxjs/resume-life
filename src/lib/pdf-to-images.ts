import path from "node:path";
import { createRequire } from "node:module";
import { FileFormatError, runInSandboxedProcess } from "./parse-sandbox";
import { readImageDimensions } from "./image-dimensions";
import { MAX_UPLOAD_FILE_BYTES } from "./request-limits";

export const MAX_OCR_PAGES = 5;
const DEFAULT_SCALE = 1.5;
const MAX_DIMENSION = 3000;
const MAX_RENDER_PIXELS = 6_000_000;
const MAX_PAGE_PNG_BYTES = 5 * 1024 * 1024;
const PDF_RENDER_TIMEOUT_MS = 15_000;
const IMAGE_RENDER_TIMEOUT_MS = 15_000;
const MAX_SOURCE_PIXELS = 12_000_000;
const MAX_SOURCE_DIMENSION = 20_000;

export type PdfPageImage = {
  pageNumber: number;
  buffer: Buffer;
  base64: string;
  width: number;
  height: number;
  hasVisualContent: boolean;
};

export function getCanvasModule(): {
  createCanvas: (width: number, height: number) => {
    getContext: (type: "2d") => unknown;
    toBuffer: (mime: string) => Buffer;
  };
  loadImage: (src: string | Buffer) => Promise<{ width: number; height: number }>;
} {
  try {
    const req = createRequire(path.resolve(process.cwd(), "package.json"));
    return req("@napi-rs/canvas");
  } catch {
    const fallbackRequire = createRequire(import.meta.url);
    return fallbackRequire("@napi-rs/canvas");
  }
}

/**
 * 将上传的单张图片（PNG/JPG/WEBP 等）处理为标准尺寸的高保真 OCR 输入对象
 */
export async function processImageBufferToPage(imageBuffer: Buffer, signal?: AbortSignal): Promise<PdfPageImage> {
  if (signal?.aborted) throw new FileFormatError("图片处理已取消");
  if (imageBuffer.byteLength > MAX_UPLOAD_FILE_BYTES) throw new FileFormatError("图片文件超过大小上限");
  const source = readImageDimensions(imageBuffer);
  if (source.width < 1 || source.height < 1 || source.width > MAX_SOURCE_DIMENSION
    || source.height > MAX_SOURCE_DIMENSION || source.width * source.height > MAX_SOURCE_PIXELS) {
    throw new FileFormatError("图片像素超过上限");
  }

  const childSource = `
    const { createRequire } = require("node:module");
    const { createCanvas, loadImage } = createRequire(process.argv[1])("@napi-rs/canvas");
    (async () => {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      let image;
      try { image = await loadImage(Buffer.concat(chunks)); }
      catch { process.stdout.write(JSON.stringify({ error: "图片文件损坏或不支持该格式" })); return; }
      if (image.width < 1 || image.height < 1 || image.width > ${MAX_SOURCE_DIMENSION}
        || image.height > ${MAX_SOURCE_DIMENSION} || image.width * image.height > ${MAX_SOURCE_PIXELS}) {
        process.stdout.write(JSON.stringify({ error: "图片像素超过上限" })); return;
      }
      const scale = Math.min(1, ${MAX_DIMENSION} / image.width, ${MAX_DIMENSION} / image.height,
        Math.sqrt(${MAX_RENDER_PIXELS} / (image.width * image.height)));
      const width = Math.max(1, Math.floor(image.width * scale));
      const height = Math.max(1, Math.floor(image.height * scale));
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0, width, height);
      const pixels = ctx.getImageData(0, 0, width, height).data;
      let hasVisualContent = false;
      // 逐像素检查；固定间隔抽样会将落在采样列之间的窄字形误判为空白。
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 10 && (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245)) {
          hasVisualContent = true; break;
        }
      }
      const png = canvas.toBuffer("image/png");
      if (png.length > ${MAX_PAGE_PNG_BYTES}) {
        process.stdout.write(JSON.stringify({ error: "图片处理结果超过大小上限" })); return;
      }
      process.stdout.write(JSON.stringify({ width, height, hasVisualContent, png: png.toString("base64") }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  return runInSandboxedProcess(
    childSource,
    path.resolve(process.cwd(), "package.json"),
    imageBuffer,
    { timeoutMs: IMAGE_RENDER_TIMEOUT_MS, maxOldSpaceSizeMb: 192 },
    "图片处理超时",
    (stdout): PdfPageImage => {
      const result = JSON.parse(stdout) as { error?: unknown; width?: unknown; height?: unknown; hasVisualContent?: unknown; png?: unknown };
      if (typeof result.error === "string") throw new FileFormatError(result.error);
      if (typeof result.width !== "number" || typeof result.height !== "number" || result.width < 1 || result.height < 1
        || result.width > MAX_DIMENSION || result.height > MAX_DIMENSION || result.width * result.height > MAX_RENDER_PIXELS
        || typeof result.hasVisualContent !== "boolean" || typeof result.png !== "string") {
        throw new FileFormatError("图片处理结果无效");
      }
      const buffer = Buffer.from(result.png, "base64");
      if (buffer.byteLength > MAX_PAGE_PNG_BYTES) throw new FileFormatError("图片处理结果超过大小上限");
      return { pageNumber: 1, buffer, base64: `data:image/png;base64,${result.png}`,
        width: result.width, height: result.height, hasVisualContent: result.hasVisualContent };
    },
    { signal, maxStdoutBytes: Math.ceil(MAX_PAGE_PNG_BYTES * 4 / 3) + 16_384 },
  );
}

/** 渲染全部或指定的原始页码，单次最多 MAX_OCR_PAGES 页，超限明确拒绝。 */
export async function renderPdfPagesToImages(
  pdfBuffer: Buffer,
  maxPages = MAX_OCR_PAGES,
  signal?: AbortSignal,
  pageNumbers?: readonly number[]
): Promise<PdfPageImage[]> {
  signal?.throwIfAborted();
  const pagesToRender = Math.min(MAX_OCR_PAGES, Math.max(0, Math.floor(maxPages)));
  // 只把已校验的升序整数嵌入沙箱源码，禁止截断、排序或去重掩盖调用错误。
  const selectedPages = pageNumbers === undefined ? undefined : [...pageNumbers];
  if (selectedPages) {
    if (!selectedPages.length || selectedPages.some((page, index) => !Number.isSafeInteger(page) || page < 1 ||
        (index > 0 && page <= selectedPages[index - 1]!))) throw new FileFormatError("PDF 选择页码无效");
    if (selectedPages.length > pagesToRender) throw new FileFormatError(`PDF 待检查页面最多支持 ${pagesToRender} 页，请拆分文件后重新导入`);
  }
  const pdfjsPath = path.resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  const childSource = `
    const path = require("node:path");
    const { pathToFileURL } = require("node:url");
    const { createCanvas } = require("@napi-rs/canvas");
    (async () => {
      const pdfjs = await import(pathToFileURL(process.argv[1]).href);
      const moduleDir = path.dirname(process.argv[1]);
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(moduleDir, "pdf.worker.mjs")).href;
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(Buffer.concat(chunks)),
        disableFontFace: false,
        useSystemFonts: true,
        cMapUrl: path.join(moduleDir, "../../cmaps/").replaceAll("\\\\", "/") + "/",
        cMapPacked: true,
        standardFontDataUrl: path.join(moduleDir, "../../standard_fonts/").replaceAll("\\\\", "/") + "/",
      }).promise;
      const pages = [];
      try {
        const selectedPages = ${JSON.stringify(selectedPages ?? null)};
        if (!selectedPages && doc.numPages > ${MAX_OCR_PAGES}) {
          process.stdout.write(JSON.stringify({ error: "扫描 PDF 共 " + doc.numPages + " 页，OCR 最多支持 ${MAX_OCR_PAGES} 页，请拆分文件后重新导入" }));
          return;
        }
        if (selectedPages?.some((page) => page > doc.numPages)) {
          process.stdout.write(JSON.stringify({ error: "PDF 选择页码超出文档范围" }));
          return;
        }
        const pageNumbers = selectedPages || Array.from({ length: Math.min(doc.numPages, ${pagesToRender}) }, (_, index) => index + 1);
        for (const p of pageNumbers) {
          const page = await doc.getPage(p);
          const base = page.getViewport({ scale: 1 });
          if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) {
            throw new Error("PDF 页面尺寸无效");
          }
          const scale = Math.min(${DEFAULT_SCALE}, ${MAX_DIMENSION} / base.width,
            ${MAX_DIMENSION} / base.height, Math.sqrt(${MAX_RENDER_PIXELS} / (base.width * base.height)));
          const viewport = page.getViewport({ scale });
          const width = Math.max(1, Math.floor(viewport.width));
          const height = Math.max(1, Math.floor(viewport.height));
          if (width > ${MAX_DIMENSION} || height > ${MAX_DIMENSION} || width * height > ${MAX_RENDER_PIXELS}) {
            throw new Error("PDF 页面尺寸超过渲染上限");
          }
          const canvas = createCanvas(width, height);
          const canvasContext = canvas.getContext("2d");
          await page.render({ canvasContext, viewport, canvas }).promise;
          const pixels = canvasContext.getImageData(0, 0, width, height).data;
          let hasVisualContent = false;
          // 逐像素检查；固定间隔抽样会将落在采样列之间的窄字形误判为空白。
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] > 10 && (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245)) {
              hasVisualContent = true;
              break;
            }
          }
          const png = canvas.toBuffer("image/png");
          if (png.length > ${MAX_PAGE_PNG_BYTES}) {
            process.stdout.write(JSON.stringify({ error: "PDF 页面图像超过大小上限" }));
            return;
          }
          pages.push({ pageNumber: p, width, height, hasVisualContent, png: png.toString("base64") });
        }
        process.stdout.write(JSON.stringify({ pages }));
      } finally {
        try { await doc.destroy(); } catch { /* 清理失败不覆盖解析结果 */ }
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  return runInSandboxedProcess<PdfPageImage[]>(
    childSource,
    pdfjsPath,
    pdfBuffer,
    { timeoutMs: PDF_RENDER_TIMEOUT_MS, maxOldSpaceSizeMb: 512 },
    "PDF 页面渲染超时",
    (stdout) => {
      const result = JSON.parse(stdout) as {
        error?: unknown;
        pages?: { pageNumber?: unknown; width?: unknown; height?: unknown; hasVisualContent?: unknown; png?: unknown }[];
      };
      if (typeof result.error === "string") throw new FileFormatError(result.error);
      if (!Array.isArray(result.pages) || result.pages.length > pagesToRender ||
          (selectedPages && result.pages.length !== selectedPages.length)) throw new FileFormatError("PDF 渲染结果无效");
      return result.pages.map((page, index) => {
        const pageNumber = selectedPages?.[index] ?? index + 1;
        if (page.pageNumber !== pageNumber || typeof page.width !== "number" || typeof page.height !== "number"
          || page.width < 1 || page.height < 1 || page.width > MAX_DIMENSION || page.height > MAX_DIMENSION
          || page.width * page.height > MAX_RENDER_PIXELS || typeof page.png !== "string"
          || typeof page.hasVisualContent !== "boolean") {
          throw new FileFormatError("PDF 渲染结果无效");
        }
        const buffer = Buffer.from(page.png, "base64");
        if (buffer.length > MAX_PAGE_PNG_BYTES) throw new FileFormatError("PDF 页面图像超过大小上限");
        return {
          pageNumber,
          buffer,
          base64: `data:image/png;base64,${page.png}`,
          width: page.width,
          height: page.height,
          hasVisualContent: page.hasVisualContent,
        };
      });
    },
    { signal, maxStdoutBytes: Math.ceil(MAX_PAGE_PNG_BYTES * 4 / 3) * (selectedPages?.length ?? pagesToRender) + 16_384 }
  );
}
