import type { PdfPageImage } from "./pdf-to-images";
import fs from "node:fs";
import path from "node:path";
import { retainParseResource } from "./parse-concurrency";
import { logServerEvent } from "./server-errors";

const LOCAL_OCR_TIMEOUT_MS = 60_000;

export type LocalOcrOptions = {
  lang?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type TesseractWorkerLike = {
  recognize: (image: Buffer) => Promise<{ data?: { text?: string } }>;
  terminate: () => Promise<unknown>;
};

/**
 * 使用本地 Tesseract.js 对 PDF 页面图像进行离线 OCR 识别
 */
export async function ocrPdfPagesLocally(
  pages: PdfPageImage[],
  options: LocalOcrOptions = {}
): Promise<string> {
  if (!pages.length) return "";

  const { lang = "chi_sim+eng", timeoutMs = LOCAL_OCR_TIMEOUT_MS, signal } = options;
  signal?.throwIfAborted();
  const langPath = process.env.RESUME_LIFE_OCR_DATA_DIR || process.cwd();
  if (!path.isAbsolute(langPath)) throw new Error("本地 OCR 语言包目录必须是绝对路径");
  for (const language of new Set([...lang.split("+"), "eng"])) {
    if (!/^[a-z_]+$/u.test(language)) throw new Error("本地 OCR 语言包名称无效");
    try {
      if (!fs.statSync(path.join(langPath, `${language}.traineddata`)).isFile()) throw new Error("invalid file");
    } catch {
      throw new Error(`本地 OCR 语言包缺失：${language}.traineddata`);
    }
  }

  const { createWorker } = await import("tesseract.js");
  signal?.throwIfAborted();
  const workerOptions = { langPath, gzip: false, cacheMethod: "none" };

  let cleanupWorker: (() => Promise<void>) | undefined;
  let stopped = false;
  let rejectStop!: (reason: Error) => void;
  const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (reason: Error) => {
    if (stopped) return;
    stopped = true;
    rejectStop(reason);
  };
  const timer = setTimeout(() => {
    stop(new Error(`本地 OCR 识别超时（超过 ${timeoutMs / 1000} 秒），请稍后重试或尝试切换至多模态识别`));
  }, timeoutMs);
  const onAbort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error("客户端已取消 OCR 操作"));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    const runOcr = async (): Promise<string> => {
      const startWorker = async (language: string): Promise<TesseractWorkerLike> => {
        const releaseResource = retainParseResource();
        let created: TesseractWorkerLike;
        try {
          created = await createWorker(language, undefined, workerOptions) as TesseractWorkerLike;
        } catch (error) {
          releaseResource();
          throw new Error(`本地 OCR 语言初始化失败（${language}），请检查本地语言包或尝试切换至多模态识别`, { cause: error });
        }
        let termination: Promise<void> | undefined;
        const cleanup = () => termination ??= (async () => {
          try {
            await created.terminate();
            releaseResource();
          } catch {
            // 无法确认资源已退出时保留名额，且不覆盖有效结果或取消/超时原因。
            logServerEvent("warn", "ocr.local_worker_cleanup_failed", { context: { resource: "local-ocr-worker" } });
          }
        })();
        if (stopped || signal?.aborted) {
          await cleanup();
          throw new Error("本地 OCR 已停止");
        }
        cleanupWorker = cleanup;
        return created;
      };

      const active = await startWorker(lang);

      signal?.throwIfAborted();
      const pageTexts: string[] = [];
      for (const page of pages) {
        if (stopped) throw new Error("本地 OCR 已停止");
        signal?.throwIfAborted();
        const ret = await active.recognize(page.buffer);
        if (stopped) throw new Error("本地 OCR 已停止");
        const text = (ret.data?.text || "").trim();
        if (text) {
          pageTexts.push(text);
        }
      }

      return pageTexts.join("\n\n");
    };
    return await Promise.race([stopped ? stopPromise : runOcr(), stopPromise]);
  } finally {
    const cancelledOrTimedOut = stopped;
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    const cleanup = cleanupWorker?.();
    // 取消/超时先返回；实际终止完成前，cleanup 仍持有共享解析名额。
    if (!cancelledOrTimedOut) await cleanup;
  }
}
