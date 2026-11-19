import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFormat } from "../settings-constants";
import type { LlmProgressObserver, LlmRequestProgress } from "../llm-request-progress";

const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic-secret", model_parse: "fake", api_format: "openai_chat" }));
const leases = vi.hoisted(() => ({ acquireLlmLease: vi.fn(() => "synthetic-lease"), releaseLlmLease: vi.fn() }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../shared-budgets", () => leases);
vi.mock("../llm-call-log", () => ({ recordLlmCall: vi.fn() }));
vi.mock("../proxy-dispatcher", () => ({ proxyFetchInit: () => ({}) }));
import { chatStream, LLM_MAX_RESPONSE_BYTES, LlmTimeoutError } from "../llm";

const content = '{"result":"正文🧪"}';
const event = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const protocols: { format: ApiFormat; delta: (text: string) => string; done: string }[] = [
  { format: "openai_chat", delta: text => event({ choices: [{ delta: { content: text } }] }), done: event("[DONE]") },
  { format: "anthropic_messages", delta: text => event({ type: "content_block_delta", delta: { type: "text_delta", text } }), done: event({ type: "message_stop" }) },
  { format: "openai_responses", delta: text => event({ type: "response.output_text.delta", delta: text }), done: event({ type: "response.completed", response: { status: "completed" } }) },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  settings.api_format = "openai_chat";
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function capture() {
  const events: LlmRequestProgress[] = [];
  const onRequestProgress: LlmProgressObserver = progress => { events.push({ ...progress }); };
  return { events, onRequestProgress };
}

function respond(wire: string, chunkBytes = 7) {
  const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    const bytes = new TextEncoder().encode(wire);
    for (let index = 0; index < bytes.length; index += chunkBytes) controller.enqueue(bytes.slice(index, index + chunkBytes));
    controller.close();
  } })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function openStream(initial: string, intervalChunk?: string) {
  const cancelled = vi.fn();
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    let onAbort: () => void;
    const cleanup = () => { clearInterval(timer); options.signal?.removeEventListener("abort", onAbort); };
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (initial) controller.enqueue(new TextEncoder().encode(initial));
        onAbort = () => { cleanup(); controller.error(options.signal?.reason); };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (intervalChunk !== undefined) timer = setInterval(() => controller.enqueue(new TextEncoder().encode(intervalChunk)), 30_000);
      },
      cancel() { cleanup(); cancelled(); },
    }));
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, cancelled };
}

describe("模型请求进度元数据", () => {
  it.each(protocols)("$format：跨 UTF-8 网络块计数且严格 JSON 校验前不交付正文", async ({ format, delta, done }) => {
    settings.api_format = format;
    const wire = ": heartbeat\n\n" + delta(content) + done;
    const fetch = respond(wire);
    const { events, onRequestProgress } = capture();
    const delivered = vi.fn();
    const observe: LlmProgressObserver = progress => {
      expect(delivered).not.toHaveBeenCalled();
      onRequestProgress(progress);
    };
    expect(await chatStream("parse", [], delivered, { requireJson: "strict", onRequestProgress: observe })).toBe(content);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(content);
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.map(x => x.phase)).toEqual(["started", "headers", "first-byte", "first-content", "ended"]);
    expect(events.at(-1)).toMatchObject({ requestIndex: 0, attempt: 0, stream: true, outcome: "complete", abortKind: null,
      httpStatus: 200, responseBytes: Buffer.byteLength(wire), contentBytes: Buffer.byteLength(content) });
    expect(events[0]).toMatchObject({ headersMs: null, firstByteMs: null, firstContentMs: null, responseBytes: 0, contentBytes: 0 });
    const last = events.at(-1)!;
    expect(last.headersMs).toBeGreaterThanOrEqual(0);
    expect(last.firstByteMs).toBeGreaterThanOrEqual(last.headersMs!);
    expect(last.firstContentMs).toBeGreaterThanOrEqual(last.firstByteMs!);
    expect(last.lastContentMs).toBeLessThanOrEqual(last.elapsedMs);
    expect(JSON.stringify(events)).not.toMatch(/正文|synthetic-secret|model\.invalid/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "bytes", "content"] as const)("取消时保留 %s 阶段，不能把空交付判作没有收到正文", async stage => {
    const initial = stage === "headers" ? "" : stage === "bytes" ? ": heartbeat\n\n" : protocols[0]!.delta('{"pending":');
    const { fetch } = openStream(initial);
    const { events, onRequestProgress } = capture();
    const controller = new AbortController();
    const delivered = vi.fn();
    const run = chatStream("parse", [], delivered, { signal: controller.signal, requireJson: "strict", onRequestProgress });
    const rejection = expect(run).rejects.toThrow("取消");
    await vi.advanceTimersByTimeAsync(20);
    controller.abort();
    await rejection;
    expect(delivered).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ outcome: "error", abortKind: "client", responseBytes: Buffer.byteLength(initial),
      contentBytes: stage === "content" ? Buffer.byteLength('{"pending":') : 0 });
    expect(events.at(-1)!.firstByteMs === null).toBe(stage === "headers");
    expect(events.at(-1)!.firstContentMs === null).toBe(stage !== "content");
    expect(vi.getTimerCount()).toBe(0);
    expect(leases.releaseLlmLease).toHaveBeenCalledOnce();
  });

  it.each([false, true])("跨 delta 的代理对按拼接后的 UTF-8 正文计数；正文上限=%s", async atLimit => {
    const prefix = '{"v":"' + (atLimit ? "a".repeat(LLM_MAX_RESPONSE_BYTES - Buffer.byteLength('{"v":"😀"}')) : "");
    const parts: string[] = [];
    for (let index = 0; index < prefix.length; index += 32_768) parts.push(prefix.slice(index, index + 32_768));
    parts.push("\ud83d", "", '\ude00"}');
    const wire = parts.map(protocols[0]!.delta).join("") + protocols[0]!.done;
    const fetch = respond(wire, 16_384);
    const { events, onRequestProgress } = capture();
    const result = await chatStream("parse", [], undefined, { requireJson: "strict", onRequestProgress });
    expect(result).toBe(prefix + '😀"}');
    expect(events.at(-1)).toMatchObject({ outcome: "complete", contentBytes: Buffer.byteLength(result), responseBytes: Buffer.byteLength(wire) });
    if (atLimit) expect(Buffer.byteLength(result)).toBe(LLM_MAX_RESPONSE_BYTES);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("响应头之前取消也有请求终态，但没有 HTTP 状态或字节", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    })));
    const { events, onRequestProgress } = capture();
    const run = chatStream("parse", [], undefined, { signal: controller.signal, onRequestProgress });
    const rejection = expect(run).rejects.toThrow();
    controller.abort();
    await rejection;
    expect(events.map(x => x.phase)).toEqual(["started", "ended"]);
    expect(events.at(-1)).toMatchObject({ httpStatus: null, headersMs: null, responseBytes: 0, contentBytes: 0, outcome: "error", abortKind: "client" });
  });

  it("调用前已取消时没有伪造请求记录", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = respond(protocols[0]!.delta(content) + protocols[0]!.done);
    const { events, onRequestProgress } = capture();
    await expect(chatStream("parse", [], undefined, { signal: controller.signal, onRequestProgress })).rejects.toThrow();
    expect(events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("静默中止后的延迟取消不能覆盖首次中止原因", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        setTimeout(() => reject(options.signal?.reason), 1000);
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const { events, onRequestProgress } = capture();
    const run = chatStream("parse", [], undefined, { signal: controller.signal, onRequestProgress }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toBeInstanceOf(LlmTimeoutError);
    expect(events.at(-1)).toMatchObject({ outcome: "error", abortKind: "idle", responseBytes: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("严格 JSON 重试与 HTTP 400 回退分别记录物理请求，读取完成不等于验证通过", async () => {
    const invalidWire = protocols[0]!.delta("not json") + protocols[0]!.done;
    const body = JSON.stringify({ choices: [{ message: { content } }] });
    const fetch = vi.fn().mockResolvedValueOnce(new Response(invalidWire))
      .mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(new Response(body));
    vi.stubGlobal("fetch", fetch);
    const { events, onRequestProgress } = capture();
    const delivered = vi.fn();
    const run = chatStream("parse", [], delivered, { requireJson: "strict", onRequestProgress });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await run).toBe(content);
    expect(delivered).toHaveBeenCalledExactlyOnceWith(content);
    expect(events.filter(x => x.phase === "ended").map(x => ({ index: x.requestIndex, attempt: x.attempt, stream: x.stream, status: x.httpStatus, outcome: x.outcome, bytes: x.contentBytes })))
      .toEqual([
        { index: 0, attempt: 0, stream: true, status: 200, outcome: "complete", bytes: 8 },
        { index: 1, attempt: 1, stream: true, status: 400, outcome: "error", bytes: 0 },
        { index: 2, attempt: 1, stream: false, status: 200, outcome: "complete", bytes: Buffer.byteLength(content) },
      ]);
    expect(events.at(-1)!.responseBytes).toBe(Buffer.byteLength(body));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject", "pending", "mutate"] as const)("观察器 %s 不改变正文、重试或后续快照", async behavior => {
    const fetch = respond(protocols[0]!.delta(content) + protocols[0]!.done);
    const { events, onRequestProgress } = capture();
    const observer: LlmProgressObserver = progress => {
      onRequestProgress(progress);
      if (behavior === "throw") throw new Error("observer failure");
      if (behavior === "reject") return Promise.reject(new Error("observer failure"));
      if (behavior === "pending") return new Promise<void>(() => {});
      (progress as LlmRequestProgress).contentBytes = -1;
    };
    expect(await chatStream("parse", [], undefined, { requireJson: "strict", onRequestProgress: observer })).toBe(content);
    expect(events.at(-1)!.contentBytes).toBe(Buffer.byteLength(content));
    expect(events).toHaveLength(5);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["", ": heartbeat\n\n"])("SSE 定期块 %j：无字节按静默截止，有字节仍受总期限约束", async chunk => {
    const { fetch } = openStream("", chunk);
    const { events, onRequestProgress } = capture();
    const controller = new AbortController();
    const run = chatStream("parse", [], undefined, { signal: controller.signal, onRequestProgress }).catch((error: unknown) => error);
    const timeout = chunk ? 300_000 : 60_000;
    try {
      await vi.advanceTimersByTimeAsync(timeout * 3 + 3001);
      const ended = events.filter(x => x.phase === "ended");
      expect(ended).toHaveLength(3);
      expect(ended.map(x => x.abortKind)).toEqual(Array(3).fill(chunk ? "total" : "idle"));
      expect(ended.every(x => x.contentBytes === 0 && x.firstContentMs === null)).toBe(true);
      expect(ended.every(x => chunk ? x.responseBytes > 0 : x.responseBytes === 0)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(await run).toBeInstanceOf(LlmTimeoutError);
    } finally { controller.abort(); await run; }
    expect(vi.getTimerCount()).toBe(0);
    expect(leases.releaseLlmLease).toHaveBeenCalledOnce();
  });
});
