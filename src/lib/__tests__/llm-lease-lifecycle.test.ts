import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../llm-call-log", () => ({ recordLlmCall: (entry: Record<string, unknown>) => recorded.calls.push(entry) }));
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-llm-lease-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", root);
  vi.resetModules();
  vi.useFakeTimers();
  recorded.calls.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("resume-life-llm-lease-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(root, { recursive: true, force: true });
});

function slowlyRetryingFetch() {
  const upstream = vi.fn((_url: string, options: RequestInit) => {
    // 有心跳但始终无答案，让请求触及五分钟总时长而非一分钟静默上限。
    const body = new ReadableStream({ start(controller) {
      const heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")), 30_000);
      options.signal!.addEventListener("abort", () => {
        clearInterval(heartbeat);
        controller.error(options.signal!.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    } });
    return Promise.resolve(new Response(body));
  });
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

it("超过旧十分钟租期仍活动的长重试占据跨模块共享名额，取消后释放", async () => {
  const { chat, LLM_MAX_CONCURRENT } = await import("../llm");
  const upstream = slowlyRetryingFetch();
  const abort = new AbortController();
  const running = Array.from({ length: LLM_MAX_CONCURRENT }, () => chat("parse", [], { signal: abort.signal }).catch((error: unknown) => error));
  let extraLease: string | null = null;
  const budget = await import("../shared-budgets");
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 4_000);
    expect(upstream).toHaveBeenCalledTimes(LLM_MAX_CONCURRENT * 3);
    vi.resetModules();
    const otherProcess = await import("../shared-budgets");
    extraLease = otherProcess.acquireLlmLease({ maxConcurrent: LLM_MAX_CONCURRENT, leaseMs: 1000 });
    expect(extraLease).toBeNull();
  } finally {
    abort.abort();
    await Promise.all(running);
    if (extraLease) budget.releaseLlmLease(extraLease);
  }
  const recovered = budget.acquireLlmLease({ maxConcurrent: 1, leaseMs: 1000 });
  expect(recovered).not.toBeNull();
  if (recovered) budget.releaseLlmLease(recovered);
  expect(vi.getTimerCount()).toBe(0);
});

it("完整调用截止优先于更晚的 lease 过期，记 timeout 而不是 cancelled", async () => {
  const { chat } = await import("../llm");
  const upstream = slowlyRetryingFetch();
  // 模拟总时长回调因调度延迟尚未执行，调用级截止仍必须阻止继续工作。
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    realSetTimeout(callback, delay === 300_000 ? 2_000_000 : delay, ...args)) as typeof setTimeout);
  const abort = new AbortController();
  let finished = false;
  const run = chat("parse", [], { source: { feature: "简历导入解析" }, signal: abort.signal }).then(() => null, (error: unknown) => error).finally(() => { finished = true; });
  try {
    await vi.advanceTimersByTimeAsync(1_203_001);
    expect(finished).toBe(true);
    expect(await run).toBeInstanceOf(Error);
    expect(upstream).toHaveBeenCalledOnce();
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "timeout" });
    const budget = await import("../shared-budgets");
    const lease = budget.acquireLlmLease({ maxConcurrent: 1, leaseMs: 1000 });
    expect(lease).not.toBeNull();
    if (lease) budget.releaseLlmLease(lease);
  } finally {
    abort.abort();
    await run;
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("两次长超时后第三次请求的400降级仍保留 lease，成功后归还", async () => {
  const { chat } = await import("../llm");
  const upstream = slowlyRetryingFetch();
  const slow = upstream.getMockImplementation()!;
  let request = 0;
  let finishFallback: (() => void) | undefined;
  upstream.mockImplementation((url, options) => {
    request += 1;
    if (request === 3) return Promise.resolve(new Response(null, { status: 400 }));
    if (request === 4) return new Promise<Response>((resolve, reject) => {
      finishFallback = () => resolve(Response.json({ choices: [{ message: { content: "complete" } }] }));
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
    return slow(url, options);
  });
  const abort = new AbortController();
  const run = chat("parse", [], { signal: abort.signal }).then((content) => content, (error: unknown) => error);
  const budget = await import("../shared-budgets");
  let extraLease: string | null = null;
  try {
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 4_000);
    expect(upstream).toHaveBeenCalledTimes(4);
    expect(JSON.parse(upstream.mock.calls[2]![1].body as string).stream).toBe(true);
    expect(JSON.parse(upstream.mock.calls[3]![1].body as string).stream).toBeUndefined();
    extraLease = budget.acquireLlmLease({ maxConcurrent: 1, leaseMs: 1000 });
    expect(extraLease).toBeNull();
    finishFallback!();
    expect(await run).toBe("complete");
  } finally {
    abort.abort();
    await run;
    if (extraLease) budget.releaseLlmLease(extraLease);
  }
  const recovered = budget.acquireLlmLease({ maxConcurrent: 1, leaseMs: 1000 });
  expect(recovered).not.toBeNull();
  if (recovered) budget.releaseLlmLease(recovered);
  expect(vi.getTimerCount()).toBe(0);
});

it("进程崩溃未执行释放的 lease 最终仍可过期回收", async () => {
  const budget = await import("../shared-budgets");
  const lost = budget.acquireLlmLease({ maxConcurrent: 1, leaseMs: 1_263_000 });
  expect(lost).not.toBeNull();
  await vi.advanceTimersByTimeAsync(1_263_001);
  const next = budget.acquireLlmLease({ maxConcurrent: 1, leaseMs: 1000 });
  expect(next).not.toBeNull();
  if (next) budget.releaseLlmLease(next);
});
