import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

const renderer = vi.hoisted(() => ({ launchServer: vi.fn(), connect: vi.fn() }));
vi.mock("playwright-core", () => ({ chromium: { launchServer: renderer.launchServer, connect: renderer.connect } }));

const browsers = new Map<string, ReturnType<typeof controlledBrowser>["browser"]>();
let nextEndpoint = 0;

function controlledBrowser() {
  let release: ((bytes: Buffer) => void) | undefined;
  const page = {
    route: vi.fn(async () => {}),
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {}),
    pdf: vi.fn(() => new Promise<Buffer>((resolve) => { release = resolve; })),
  };
  const browser = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  const endpoint = `ws://pdf-test-${++nextEndpoint}`;
  const server = {
    wsEndpoint: vi.fn(() => endpoint),
    close: vi.fn(async () => { await browser.close(); }),
    kill: vi.fn(async () => {}),
  };
  browsers.set(endpoint, browser);
  return { server, browser, page, release: () => release?.(Buffer.from("%PDF-1.4")) };
}

beforeEach(() => {
  vi.resetModules();
  browsers.clear();
  nextEndpoint = 0;
  renderer.launchServer.mockReset();
  renderer.connect.mockReset().mockImplementation(async (endpoint: string) => {
    const browser = browsers.get(endpoint);
    if (!browser) throw new Error("Unknown browser endpoint");
    return browser;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PDF 导出资源预算", () => {
  it("最多同时启动两个浏览器，额外请求立即得到繁忙错误", async () => {
    const first = controlledBrowser();
    const second = controlledBrowser();
    renderer.launchServer.mockResolvedValueOnce(first.server).mockResolvedValueOnce(second.server)
      .mockRejectedValue(new Error("不应启动第三个 Chromium"));
    const { generateResumePdf } = await import("../pdf-render");
    const one = generateResumePdf("<html></html>");
    await vi.waitFor(() => expect(first.page.pdf).toHaveBeenCalledOnce());
    const two = generateResumePdf("<html></html>");
    try {
      await vi.waitFor(() => expect(second.page.pdf).toHaveBeenCalledOnce());
      await expect(generateResumePdf("<html></html>")).rejects.toThrow("PDF 导出繁忙");
      expect(renderer.launchServer).toHaveBeenCalledTimes(2);
    } finally {
      first.release();
      second.release();
      await Promise.allSettled([one, two]);
    }
  });

  it("关闭挂起时不会释放浏览器并发名额", async () => {
    const first = controlledBrowser();
    const second = controlledBrowser();
    let finishKill!: () => void;
    first.server.close.mockImplementationOnce(() => new Promise<void>(() => {}));
    first.server.kill.mockImplementationOnce(() => new Promise<void>((resolve) => { finishKill = resolve; }));
    renderer.launchServer.mockResolvedValueOnce(first.server).mockResolvedValueOnce(second.server)
      .mockRejectedValue(new Error("unexpected third Chromium"));
    const { generateResumePdf } = await import("../pdf-render");
    const one = generateResumePdf("<html></html>");
    await vi.waitFor(() => expect(first.page.pdf).toHaveBeenCalledOnce());
    const two = generateResumePdf("<html></html>");
    try {
      await vi.waitFor(() => expect(second.page.pdf).toHaveBeenCalledOnce());
      vi.useFakeTimers();
      first.release();
      await vi.advanceTimersByTimeAsync(2_001);
      expect(first.server.kill).toHaveBeenCalledOnce();
      await expect(generateResumePdf("<html></html>")).rejects.toThrow("PDF 导出繁忙");
      expect(renderer.launchServer).toHaveBeenCalledTimes(2);
      finishKill();
      await vi.advanceTimersByTimeAsync(1);
      const third = controlledBrowser();
      renderer.launchServer.mockResolvedValueOnce(third.server);
      const resumed = generateResumePdf("<html></html>");
      await vi.advanceTimersByTimeAsync(1);
      expect(third.page.pdf).toHaveBeenCalledOnce();
      third.release();
      await resumed;
      expect(renderer.launchServer).toHaveBeenCalledTimes(3);
    } finally {
      finishKill?.();
      second.release();
      await Promise.allSettled([one, two]);
    }
  });

  it("整体超时会终止挂起的 PDF 任务并关闭浏览器", async () => {
    const controlled = controlledBrowser();
    renderer.launchServer.mockResolvedValue(controlled.server);
    const { generateResumePdf, PDF_EXPORT_TIMEOUT_MS } = await import("../pdf-render");
    vi.useFakeTimers();
    const result = generateResumePdf("<html></html>");
    const timedOut = expect(result).rejects.toThrow("PDF 导出超时");
    await vi.advanceTimersByTimeAsync(PDF_EXPORT_TIMEOUT_MS + 1);
    await timedOut;
    expect(controlled.server.close).toHaveBeenCalled();
  });

  it("请求取消会终止挂起的 PDF 任务并关闭浏览器", async () => {
    const controlled = controlledBrowser();
    renderer.launchServer.mockResolvedValue(controlled.server);
    const { generateResumePdf } = await import("../pdf-render");
    const controller = new AbortController();
    const result = generateResumePdf("<html></html>", controller.signal);
    await vi.waitFor(() => expect(controlled.page.pdf).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).rejects.toThrow("PDF 导出已取消");
    expect(controlled.server.close).toHaveBeenCalled();
  });

  it("启动期间取消时，迟到的浏览器也会被关闭", async () => {
    const controlled = controlledBrowser();
    let finishLaunch!: (server: typeof controlled.server) => void;
    renderer.launchServer.mockImplementationOnce(() => new Promise((resolve) => { finishLaunch = resolve; }));
    const { generateResumePdf } = await import("../pdf-render");
    const controller = new AbortController();
    const result = generateResumePdf("<html></html>", controller.signal);
    await vi.waitFor(() => expect(renderer.launchServer).toHaveBeenCalledOnce());
    controller.abort();
    await expect(result).rejects.toThrow("PDF 导出已取消");
    finishLaunch(controlled.server);
    await vi.waitFor(() => expect(controlled.server.close).toHaveBeenCalledOnce());
  });

  it("路由在第三个导出请求到来时返回 429", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-pdf-budget-"));
    vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
    const first = controlledBrowser();
    const second = controlledBrowser();
    renderer.launchServer.mockResolvedValueOnce(first.server).mockResolvedValueOnce(second.server)
      .mockRejectedValue(new Error("不应启动第三个 Chromium"));
    let database: DatabaseSync | undefined;
    let one: Promise<Response> | undefined;
    let two: Promise<Response> | undefined;
    try {
      database = (await import("../db")).getDb();
      database.prepare("INSERT INTO resumes (id,title,template,created_at,updated_at) VALUES (1,'导出预算','classic','','')").run();
      const { GET } = await import("@/app/api/resumes/[id]/export/pdf/route");
      const request = () => new Request("http://127.0.0.1/api/resumes/1/export/pdf");
      const context = () => ({ params: Promise.resolve({ id: "1" }) });
      one = GET(request(), context());
      await vi.waitFor(() => expect(first.page.pdf).toHaveBeenCalledOnce());
      two = GET(request(), context());
      await vi.waitFor(() => expect(second.page.pdf).toHaveBeenCalledOnce());
      const busy = await GET(request(), context());
      expect(busy.status).toBe(429);
      expect(busy.headers.get("Retry-After")).toBe("5");
      expect(renderer.launchServer).toHaveBeenCalledTimes(2);
    } finally {
      first.release();
      second.release();
      await Promise.allSettled([one, two].filter((value): value is Promise<Response> => Boolean(value)));
      database?.close();
      vi.unstubAllEnvs();
      if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-pdf-budget-")) {
        throw new Error("Unsafe cleanup path");
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
