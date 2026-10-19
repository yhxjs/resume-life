import { renderToStaticMarkup } from "react-dom/server.edge";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { ResumeDoc, prepare } from "@/components/resume/doc";
import { resolveStyle, type CustomTemplate } from "@/lib/templates";
import type { ResumeWithModules } from "@/lib/resumes";
import { readUploadFile, uploadPathFromUrl } from "@/lib/upload-storage";
import type { BrowserServer } from "playwright-core";

let cachedGeistBase64: string | null = null;
function getGeistBase64(): string {
  if (cachedGeistBase64 !== null) return cachedGeistBase64;
  try {
    const fontPath = path.join(process.cwd(), "node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2");
    if (fs.existsSync(fontPath)) {
      cachedGeistBase64 = fs.readFileSync(fontPath).toString("base64");
    } else {
      cachedGeistBase64 = "";
    }
  } catch {
    cachedGeistBase64 = "";
  }
  return cachedGeistBase64;
}

/**
 * 构造用于 Playwright 导出 A4 矢量 PDF 的完整独立 HTML 文档。
 * 纯内联样式与标准排版，不依赖外部 CSS 文件或运行期 JS。
 */
export function renderResumeToHtml(data: {
  resume: Pick<ResumeWithModules["resume"], "title" | "template" | "style_overrides" | "resolved_style">;
  modules: ResumeWithModules["modules"];
}, customs: CustomTemplate[]): string {
  const prepared = prepare(data.resume.title, data.modules);

  // PDF 仅内嵌本站上传文件；丢失的头像不交给无头浏览器请求。
  if (prepared.avatar) {
    const localPath = uploadPathFromUrl(prepared.avatar);
    const file = localPath ? readUploadFile(path.basename(localPath)) : null;
    prepared.avatar = file && file.contentType.startsWith("image/")
      ? `data:${file.contentType};base64,${Buffer.from(file.bytes).toString("base64")}`
      : undefined;
  }

  const style = data.resume.resolved_style ?? resolveStyle(data.resume.template, customs, data.resume.style_overrides);
  const bodyMarkup = renderToStaticMarkup(
    React.createElement(ResumeDoc, { prepared, style })
  );

  const geistFont = getGeistBase64();
  const fontFaceCss = geistFont
    ? `@font-face {
      font-family: 'Geist Variable';
      font-style: normal;
      font-display: swap;
      font-weight: 100 900;
      src: url('data:font/woff2;base64,${geistFont}') format('woff2-variations');
    }`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(data.resume.title)}</title>
  <style>
    ${fontFaceCss}
    @page {
      size: A4;
      margin-top: ${style.pageMargin}mm;
      margin-bottom: ${style.pageMargin}mm;
      margin-left: 0;
      margin-right: 0;
    }
    @page :first {
      margin-top: 0mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      border-width: 0;
      border-style: solid;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    /* 与前端 Tailwind Preflight 保持一致的重置样式，清除浏览器原生标签默认外边距 */
    body, h1, h2, h3, h4, h5, h6, p, ul, ol, dl, dd, blockquote, figure, hr {
      margin: 0;
      padding: 0;
    }
    h1, h2, h3, h4, h5, h6 {
      font-size: inherit;
      font-weight: inherit;
    }
    ul, ol {
      list-style: none;
    }
    p {
      line-height: inherit;
    }
    html, body {
      margin: 0;
      padding: 0;
      background-color: #ffffff;
      color: #000000;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      text-rendering: optimizeLegibility;
    }
    body {
      font-family: 'Geist Variable', "PingFang SC", "Noto Sans SC", "Source Han Sans SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    }
    .font-serif {
      font-family: "Songti SC", "SimSun", Georgia, serif !important;
    }
    .paper {
      width: 210mm;
      margin: 0 auto;
      background-color: #ffffff;
    }
  </style>
</head>
<body>
  <div class="paper">
    ${bodyMarkup}
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 只加载当前简历引用的自定义模板，避免无关坏记录阻断导出。
 */
export { loadCustomTemplate } from "./custom-templates";

/**
 * 启动无头浏览器并生成矢量 A4 PDF 二进制 Buffer
 */
export const PDF_EXPORT_TIMEOUT_MS = 30_000;
const PDF_CLOSE_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_PDF_EXPORTS = 2;
let activePdfExports = 0;

export class PdfExportBusyError extends Error {
  constructor() { super("PDF 导出繁忙，请稍后重试"); }
}

export class PdfExportTimeoutError extends Error {
  constructor() { super("PDF 导出超时，请稍后重试"); }
}

export class PdfExportCancelledError extends Error {
  constructor() { super("PDF 导出已取消"); }
}

function withAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** 启动受并发、截止时间和请求取消约束的浏览器并生成矢量 A4 PDF。 */
export async function generateResumePdf(html: string, requestSignal?: AbortSignal): Promise<Buffer> {
  if (requestSignal?.aborted) throw new PdfExportCancelledError();
  if (activePdfExports >= MAX_CONCURRENT_PDF_EXPORTS) throw new PdfExportBusyError();
  activePdfExports += 1;
  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = controller.signal;
  const onRequestAbort = () => controller.abort(new PdfExportCancelledError());
  requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new PdfExportTimeoutError()), PDF_EXPORT_TIMEOUT_MS);
  let browserServer: BrowserServer | undefined;
  let pendingLaunch: Promise<BrowserServer> | undefined;
  let closePromise: Promise<void> | undefined;
  const closeBrowser = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        const current = browserServer ?? await pendingLaunch?.catch(() => undefined);
        if (!current) return;
        const closeTask = Promise.resolve().then(() => current.close()).then(() => true, () => false);
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const closed = await Promise.race([closeTask, new Promise<boolean>((resolve) => {
          closeTimer = setTimeout(() => resolve(false), PDF_CLOSE_TIMEOUT_MS);
        })]);
        if (closeTimer) clearTimeout(closeTimer);
        if (!closed) {
          console.error("PDF browser close timed out or failed");
          await current.kill();
        }
      })();
      void closePromise.then(
        () => { activePdfExports -= 1; },
        () => { console.error("PDF browser termination failed"); },
      );
    }
    return closePromise;
  };
  const waitForClose = async (): Promise<void> => {
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closeBrowser().catch(() => {}), new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, PDF_CLOSE_TIMEOUT_MS);
      })]);
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
    }
  };
  const onAbort = () => { void closeBrowser(); };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const { chromium } = await withAbort(import("playwright-core"), signal);
    const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
    for (const channel of [undefined, "chrome", "msedge"] as const) {
      if (signal.aborted) throw signal.reason;
      try {
        const launch = chromium.launchServer({ headless: true, channel, args,
          timeout: Math.max(1, PDF_EXPORT_TIMEOUT_MS - (Date.now() - startedAt)) });
        pendingLaunch = launch;
        browserServer = await withAbort(launch, signal);
        pendingLaunch = undefined;
        break;
      } catch (error) {
        if (signal.aborted || channel === "msedge") throw error;
        pendingLaunch = undefined;
      }
    }
    if (!browserServer) throw new Error("无法启动 PDF 浏览器");
    const browser = await withAbort(chromium.connect(browserServer.wsEndpoint(), {
      timeout: Math.max(1, PDF_EXPORT_TIMEOUT_MS - (Date.now() - startedAt)),
    }), signal);
    const page = await withAbort(browser.newPage(), signal);
    await withAbort(page.route("**/*", (route) => route.abort()), signal);
    await withAbort(page.setContent(html, { waitUntil: "networkidle" }), signal);
    await withAbort(page.evaluate(() => document.fonts.ready), signal);
    const pdfBuffer = await withAbort(page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    }), signal);
    return Buffer.from(pdfBuffer);
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", onRequestAbort);
    signal.removeEventListener("abort", onAbort);
    await waitForClose();
  }
}
