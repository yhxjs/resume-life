import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmSource } from "../llm-source";

const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
const leases = vi.hoisted(() => ({ acquire: vi.fn(() => "synthetic-lease"), release: vi.fn() }));
vi.mock("../settings", () => ({
  readSettings: () => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }),
}));
vi.mock("../llm-call-log", () => ({ recordLlmCall: (entry: Record<string, unknown>) => recorded.calls.push(entry) }));
vi.mock("../shared-budgets", () => ({ acquireLlmLease: leases.acquire, releaseLlmLease: leases.release }));
vi.mock("../proxy-dispatcher", () => ({ proxyFetchInit: () => ({}) }));

import { chat, LlmTimeoutError } from "../llm";

const SOURCE: LlmSource = { feature: "简历导入解析" };
type Outcome = { content: string } | { error: unknown };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  recorded.calls.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fallbackWithBody(mode: "complete" | "active" | "silent" | "empty") {
  const abortedAt: number[] = [];
  const chunksRead: number[] = [];
  let requests = 0;
  const upstream = vi.fn(async (_url: string, options: RequestInit) => {
    if (++requests === 1) return new Response(null, { status: 400 });
    const began = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let interval: ReturnType<typeof setInterval> | undefined;
    let onAbort: () => void;
    const cleanup = () => {
      timers.forEach(clearTimeout);
      clearInterval(interval);
      options.signal?.removeEventListener("abort", onAbort);
    };
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          chunksRead.push(Date.now() - began);
          controller.enqueue(new TextEncoder().encode(text));
        };
        onAbort = () => {
          abortedAt.push(Date.now() - began);
          cleanup();
          controller.error(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (mode === "complete") {
          // 整个 JSON 需 90 秒才完整，相邻数据块始终只有 30 秒间隔。
          const chunks = ['{"choices":[', '{"message":{"content":"{\\"ok\\":true}"}}', "]}"];
          chunks.forEach((text, index) => timers.push(setTimeout(() => {
            write(text);
            if (index === chunks.length - 1) {
              cleanup();
              controller.close();
            }
          }, (index + 1) * 30_000)));
        } else if (mode === "active") {
          // JSON 前的空白持续到达，但永远不完成；不能靠活动无限延长总时长。
          interval = setInterval(() => write(" "), 30_000);
        } else if (mode === "empty") {
          interval = setInterval(() => write(""), 30_000);
        }
      },
      cancel: cleanup,
    }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", upstream);
  return { upstream, abortedAt, chunksRead };
}

async function observeCall(advanceMs: number, inspect: (outcome: Outcome | undefined) => void) {
  const controller = new AbortController();
  let outcome: Outcome | undefined;
  const running = chat("parse", [], { source: SOURCE, signal: controller.signal, requireJson: "strict" })
    .then((content) => { outcome = { content }; }, (error: unknown) => { outcome = { error }; });
  try {
    await vi.advanceTimersByTimeAsync(advanceMs);
    inspect(outcome);
  } finally {
    controller.abort();
    await running;
  }
  expect(vi.getTimerCount()).toBe(0);
  expect(leases.release).toHaveBeenCalledOnce();
}

describe("非流式回退的静默与总时长边界", () => {
  it("每 30 秒到达一块的 JSON 可在 90 秒完成，不被请求起点的静默计时误杀", async () => {
    const { upstream, abortedAt, chunksRead } = fallbackWithBody("complete");
    await observeCall(90_001, outcome => {
      expect(outcome).toEqual({ content: '{"ok":true}' });
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(JSON.parse(upstream.mock.calls[0]![1].body as string).stream).toBe(true);
      expect(JSON.parse(upstream.mock.calls[1]![1].body as string).stream).toBeUndefined();
      expect(chunksRead).toEqual([30_000, 60_000, 90_000]);
      expect(abortedAt).toEqual([]);
      expect(recorded.calls).toHaveLength(1);
      expect(recorded.calls[0]).toMatchObject({ status: "ok", errorCode: "", attempts: 0 });
    });
  });

  it("持续有数据但不结束仍受每次 300 秒总期限约束，重试也不突破既有上限", async () => {
    const { upstream, abortedAt, chunksRead } = fallbackWithBody("active");
    await observeCall(903_001, outcome => {
      expect(outcome).toHaveProperty("error");
      const error = outcome && "error" in outcome ? outcome.error : undefined;
      expect(error).toBeInstanceOf(LlmTimeoutError);
      expect((error as Error).message).toContain("300 秒未完成");
      expect(abortedAt).toEqual([300_000, 300_000, 300_000]);
      expect(chunksRead).toContain(270_000);
      expect(upstream).toHaveBeenCalledTimes(4);
      expect(recorded.calls).toHaveLength(1);
      expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "timeout", attempts: 2 });
    });
  });

  it.each(["silent", "empty"] as const)("响应体模式 %s 没有实际字节时每次仍在 60 秒静默后中止", async mode => {
    const { upstream, abortedAt, chunksRead } = fallbackWithBody(mode);
    await observeCall(183_001, outcome => {
      expect(outcome).toHaveProperty("error");
      const error = outcome && "error" in outcome ? outcome.error : undefined;
      expect(error).toBeInstanceOf(LlmTimeoutError);
      expect((error as Error).message).toContain("60 秒未收到新数据");
      expect(abortedAt).toEqual([60_000, 60_000, 60_000]);
      if (mode === "silent") expect(chunksRead).toEqual([]);
      else expect(chunksRead).toEqual([30_000, 30_000, 30_000]);
      expect(upstream).toHaveBeenCalledTimes(4);
      expect(recorded.calls).toHaveLength(1);
      expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "timeout", attempts: 2 });
    });
  });
});
