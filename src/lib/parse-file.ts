import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { assertDocxArchiveBudget } from "./docx-budget";
import {
  FileFormatError,
  runInSandboxedProcess,
  runInSandboxedWorker,
  UNPARSEABLE_MESSAGE,
} from "./parse-sandbox";
import { recognizeScannedPdf, recognizeImage } from "./ocr-service";
import { withParsingSlot } from "./parse-concurrency";

export { ParseBusyError } from "./parse-concurrency";

export class PdfNoTextError extends FileFormatError {
  constructor(message = "PDF 文件未包含可选中文本（可能为图片扫描件或未内嵌字体的打印件）") {
    super(message);
    this.name = "PdfNoTextError";
  }
}

const MAX_DOCX_TEXT_CHARS = 200_000;
/** 纯文本同样必须有界：10 MiB 的 txt 会一次解出千万字符的常驻字符串，
 *  且 /api/import/parse 的 extractOnly 分支会把完整原文原样回传给客户端。
 *  计数基准与 MAX_PROJECT_MATERIAL_CHARS 一致，按 Unicode 码点。 */
const MAX_TEXT_CHARS = 200_000;
const DOCX_TIMEOUT_MS = 10_000;
const PDF_TIMEOUT_MS = 10_000;
// pdf.js 解析大文档比 mammoth 更吃内存，堆上限相应放宽，但必须仍然有界
const PDF_MAX_OLD_SPACE_MB = 512;
// 本文件与 request-limits.ts 的四道上限单位并不一致，改动时别混用：
//   MAX_JSON_REQUEST_BYTES      1 MiB   字节 —— 请求体传输体积
//   MAX_UPLOAD_FILE_BYTES       10 MiB  字节 —— 上传文件体积
//   MAX_PROJECT_MATERIAL_CHARS  200_000 码点 —— 材料正文（assertProjectMaterial）
//   本文件两个 MAX_*_CHARS     200_000 码点 —— 提取出的正文，PDF/docx/txt 各取一道
// 体积是传输层的界，码点是内容层的界：同一份文本的字节数取决于编码，
// 用字节数当内容上限会让中文材料比英文材料更早被拒。
function resolveModulePath(specifier: "mammoth" | "pdf-parse"): string {
  const localRequire = createRequire(import.meta.url);
  const traced = specifier === "mammoth"
    ? localRequire.resolve("mammoth")
    : localRequire.resolve("pdf-parse");
  // Turbopack traces literal resolutions but replaces their paths with module IDs.
  const resolved = typeof traced === "string" ? traced : specifier === "mammoth"
    ? localRequire.resolve(/* turbopackIgnore: true */ "mammoth")
    : localRequire.resolve(/* turbopackIgnore: true */ "pdf-parse");
  return resolved.startsWith("[") || resolved.includes("[external]") ? specifier : resolved;
}

async function extractDocxInWorker(data: Buffer, signal?: AbortSignal): Promise<string> {
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    let mammoth;
    try {
      mammoth = require(workerData.mammothPath);
    } catch {
      mammoth = require("mammoth");
    }
    mammoth.extractRawText({ buffer: Buffer.from(workerData.data) }).then((result) => {
      const value = result.value || "";
      // 与纯文本入口一致，按 Unicode 码点计数并在超限时提前退出。
      let codePoints = 0;
      for (const character of value) {
        if (++codePoints > workerData.maxChars) {
          parentPort.postMessage({ tooLong: true });
          return;
        }
      }
      parentPort.postMessage({ value });
    }, () => parentPort.postMessage({ invalid: true }));
  `;
  return runInSandboxedWorker<{ value?: unknown; tooLong?: unknown; invalid?: unknown }, string>(
    workerSource,
    {
      data,
      mammothPath: resolveModulePath("mammoth"),
      maxChars: MAX_DOCX_TEXT_CHARS,
    },
    { timeoutMs: DOCX_TIMEOUT_MS, maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
    "Word 文档解析超时",
    (message) => {
      if (message.tooLong) throw new FileFormatError(`Word 文档提取文本不得超过 ${MAX_DOCX_TEXT_CHARS} 字符`);
      if (typeof message.value !== "string" || message.invalid) throw new FileFormatError(UNPARSEABLE_MESSAGE);
      return message.value;
    },
    { signal }
  );
}

async function extractPdfInProcess(data: Buffer, signal?: AbortSignal): Promise<string> {
  const childSource = `
    let pdfParseModule;
    try {
      pdfParseModule = require(process.argv[1]);
    } catch {
      pdfParseModule = require("pdf-parse");
    }
    const { PDFParse } = pdfParseModule;
    // 与 docx 同构：在沙箱内判定超限，超长正文不经过 IPC 回传
    const MAX_CHARS = ${MAX_TEXT_CHARS};
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", async () => {
      let parser;
      try {
        parser = new PDFParse({ data: new Uint8Array(Buffer.concat(chunks)) });
        let text = "";
        try {
          await parser.load();
          const doc = parser.doc;
          if (doc && doc.numPages > 0) {
            const pageTexts = [];
            for (let p = 1; p <= doc.numPages; p++) {
              const page = await doc.getPage(p);
              const tc = await page.getTextContent();
              const items = tc.items
                .filter((it) => typeof it.str === "string" && it.str.length > 0)
                .map((it) => ({
                  str: it.str,
                  x: it.transform[4],
                  y: it.transform[5],
                }));
              items.sort((a, b) => Math.abs(a.y - b.y) <= 4 ? a.x - b.x : b.y - a.y);
              const lines = [];
              let cur = [];
              let lastY = null;
              for (const it of items) {
                if (lastY === null || Math.abs(it.y - lastY) <= 4) {
                  cur.push(it.str);
                  lastY = it.y;
                } else {
                  lines.push(cur.join(" "));
                  cur = [it.str];
                  lastY = it.y;
                }
              }
              if (cur.length) lines.push(cur.join(" "));
              pageTexts.push(lines.join(String.fromCharCode(10)));
            }
            text = pageTexts.join(String.fromCharCode(10) + String.fromCharCode(10)).trim();
          }
        } catch {
          // 视觉排序提取失败时回退到默认 getText
        }
        if (!text) {
          const result = await parser.getText();
          text = result.text || "";
        }
        // 过滤掉纯分页占位符，判断是否有实质内容
        const stripped = text.replace(new RegExp("--\\\\s*\\\\d+\\\\s+of\\\\s+\\\\d+\\\\s*--", "gi"), "").trim();
        if (!stripped) {
          process.stdout.write(JSON.stringify({ noText: true }));
          return;
        }
        // 沙箱内按 Unicode 码点判定上限，超长正文不经过 IPC。
        let codePoints = 0;
        for (const character of text) {
          if (++codePoints > MAX_CHARS) {
            process.stdout.write(JSON.stringify({ tooLong: true }));
            return;
          }
        }
        process.stdout.write(JSON.stringify({ value: text }));
      } catch {
        process.stdout.write(JSON.stringify({ invalid: true }));
      } finally {
        try { await parser?.destroy(); } catch { /* 销毁失败不影响已取到的结果 */ }
      }
    });
  `;
  return runInSandboxedProcess<string>(
    childSource,
    resolveModulePath("pdf-parse"),
    data,
    { timeoutMs: PDF_TIMEOUT_MS, maxOldSpaceSizeMb: PDF_MAX_OLD_SPACE_MB },
    "PDF 解析超时",
    (stdout) => {
      const message = JSON.parse(stdout) as { value?: unknown; tooLong?: unknown; invalid?: unknown; noText?: unknown };
      if (message.tooLong) throw new FileFormatError(`PDF 提取文本不得超过 ${MAX_TEXT_CHARS} 字符`);
      if (message.noText) throw new PdfNoTextError();
      if (typeof message.value !== "string" || message.invalid) throw new FileFormatError(UNPARSEABLE_MESSAGE);
      return message.value;
    },
    { signal }
  );
}

/** 按 Unicode 码点计数，与 request-limits.ts 的 assertProjectMaterial 同构；超限即提前退出 */
function exceedsMaxChars(text: string, maxChars: number): boolean {
  let codePoints = 0;
  const iterator = text[Symbol.iterator]();
  while (!iterator.next().done) {
    codePoints += 1;
    if (codePoints > maxChars) return true;
  }
  return false;
}

function decodeTextBuffer(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    try {
      return new TextDecoder("gbk", { fatal: true }).decode(data);
    } catch {
      return new TextDecoder("utf-8", { fatal: false }).decode(data);
    }
  }
}

export type ExtractTextOptions = {
  signal?: AbortSignal;
};

export type ExtractedFileContent = {
  text: string;
  ocr?: {
    engine: "vision" | "local";
    pageCount: number;
    sourceType?: "pdf" | "image";
  };
};

/** 按扩展名提取文件的纯文本及结构化元信息（如 OCR 识别方法），供简历/材料解析使用 */
export async function extractContentFromFile(
  filename: string,
  data: Buffer,
  options?: ExtractTextOptions
): Promise<ExtractedFileContent> {
  return withParsingSlot(() => extractFileContent(filename, data, options), options?.signal);
}

async function extractFileContent(
  filename: string,
  data: Buffer,
  options?: ExtractTextOptions
): Promise<ExtractedFileContent> {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf": {
      try {
        const text = await extractPdfInProcess(data, options?.signal);
        return { text };
      } catch (err) {
        options?.signal?.throwIfAborted();
        if (err instanceof PdfNoTextError) {
          try {
            // 扫描件进入 OCR 双轨处理流程
            const ocrResult = await recognizeScannedPdf(data, options?.signal);
            if (exceedsMaxChars(ocrResult.text, MAX_TEXT_CHARS)) {
              throw new FileFormatError(`PDF 提取文本不得超过 ${MAX_TEXT_CHARS} 字符`);
            }
            return {
              text: ocrResult.text,
              ocr: {
                engine: ocrResult.engine,
                pageCount: ocrResult.pageCount,
                sourceType: "pdf",
              },
            };
          } catch (ocrErr) {
            options?.signal?.throwIfAborted();
            throw ocrErr instanceof FileFormatError
              ? ocrErr
              : new FileFormatError(
                  ocrErr instanceof Error
                    ? `扫描版 PDF 识别失败：${ocrErr.message}`
                    : "扫描版 PDF OCR 识别失败"
                );
          }
        }
        // 沙箱主动抛出的 FileFormatError 带具体原因（超长、超时），必须原样透出：
        // 两个调用方路由都把 err.message 回显给客户端，覆写成通用文案会让用户
        // 只看到「文件内容无法解析」，无从判断该换个文件还是改小一点。
        throw err instanceof FileFormatError ? err : new FileFormatError(UNPARSEABLE_MESSAGE);
      }
    }
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
    case ".bmp": {
      try {
        const ocrResult = await recognizeImage(data, options?.signal);
        if (exceedsMaxChars(ocrResult.text, MAX_TEXT_CHARS)) {
          throw new FileFormatError(`图片提取文本不得超过 ${MAX_TEXT_CHARS} 字符`);
        }
        return {
          text: ocrResult.text,
          ocr: {
            engine: ocrResult.engine,
            pageCount: ocrResult.pageCount,
            sourceType: "image",
          },
        };
      } catch (ocrErr) {
        options?.signal?.throwIfAborted();
        throw ocrErr instanceof FileFormatError
          ? ocrErr
          : new FileFormatError(
              ocrErr instanceof Error
                ? `图片识别失败：${ocrErr.message}`
                : "图片 OCR 识别失败"
            );
      }
    }
    case ".docx": {
      try {
        assertDocxArchiveBudget(data);
        const text = await extractDocxInWorker(data, options?.signal);
        return { text };
      } catch (err) {
        options?.signal?.throwIfAborted();
        // 同上。注意 DocxBudgetError 不是 FileFormatError，仍会落到通用文案；
        // 沙箱超时也走 parse-sandbox 的通用文案分支——这两处属既有行为，不在本次收口范围。
        throw err instanceof FileFormatError ? err : new FileFormatError(UNPARSEABLE_MESSAGE);
      }
    }
    case ".txt":
    case ".md":
    case ".markdown": {
      const text = decodeTextBuffer(data);
      if (exceedsMaxChars(text, MAX_TEXT_CHARS)) {
        throw new FileFormatError(`文本不得超过 ${MAX_TEXT_CHARS} 字符`);
      }
      return { text };
    }
    default:
      throw new FileFormatError(`暂不支持该文件类型：${ext || "(无扩展名)"}，请上传 PDF、图片（PNG/JPG/WEBP）、Word（docx）、txt 或 md`);
  }
}

export async function extractContentFromPath(
  filename: string,
  filePath: string,
  options?: ExtractTextOptions
): Promise<ExtractedFileContent> {
  return withParsingSlot(async () => {
    const data = await fs.promises.readFile(filePath, { signal: options?.signal });
    options?.signal?.throwIfAborted();
    return extractFileContent(filename, data, options);
  }, options?.signal);
}

/** 按扩展名提取文件的纯文本 */
export async function extractTextFromFile(
  filename: string,
  data: Buffer,
  options?: ExtractTextOptions
): Promise<string> {
  const result = await extractContentFromFile(filename, data, options);
  return result.text;
}

export async function extractTextFromPath(
  filename: string,
  filePath: string,
  options?: ExtractTextOptions
): Promise<string> {
  const result = await extractContentFromPath(filename, filePath, options);
  return result.text;
}
