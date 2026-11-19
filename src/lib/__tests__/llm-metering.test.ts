import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmSource, LlmUsage } from "../llm-source";
import { MAX_MODEL_INPUT_CHARS } from "../llm-input-budget";

const settings = vi.hoisted(() => ({
  base_url: "https://model.invalid/v1",
  api_key: "synthetic",
  model_parse: "fake",
  model_summary: "fake",
  api_format: "openai_chat",
}));
const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../llm-call-log", () => ({
  recordLlmCall: (record: Record<string, unknown>) => { recorded.calls.push(record); },
}));

import { chatStream } from "../llm";

const SOURCE: LlmSource = { feature: "简历润色", entity: { type: "resume", id: 12 } };
const onUsage = vi.fn<(usage: LlmUsage) => void | Promise<void>>();

/**
 * chatStream 默认走流式（useStream = true），所以成功路径必须返回 SSE 正文。
 * 返回 JSON 会让 readSseContent 读不到 data: 行而抛「流式响应意外中断」。
 */
function sseResponse(chunks: unknown[]) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function respondSse(chunks: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => sseResponse(chunks)));
}

beforeEach(() => {
  recorded.calls.length = 0;
  onUsage.mockReset();
  settings.base_url = "https://model.invalid/v1";
  settings.api_format = "openai_chat";
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chatStream 计量", () => {
  it("模型内容请求不自动跟随跨源重定向", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { Location: "https://attacker.invalid/" } }));
    vi.stubGlobal("fetch", upstream);
    await expect(chatStream("summary", [], undefined, { source: SOURCE })).rejects.toThrow();
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("流式用量先到达随后取消时保留已报告的 token", async () => {
    const controller = new AbortController();
    respondSse([
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } },
      { choices: [{ delta: { content: "partial" } }] },
    ]);
    await expect(chatStream("summary", [], () => controller.abort(), { source: SOURCE, signal: controller.signal, onUsage })).rejects.toThrow();
    expect(recorded.calls[0]).toMatchObject({ status: "cancelled", usage: { inputTokens: 12, outputTokens: 2 } });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 12, outputTokens: 2, cachedTokens: null });
  });

  it("用量到达后流意外结束仍记录已报告的 token", async () => {
    const sse = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } })));
    await expect(chatStream("summary", [], undefined, { source: SOURCE, onUsage })).rejects.toThrow();
    expect(recorded.calls[0]).toMatchObject({ status: "failed", usage: { inputTokens: 11, outputTokens: 3 } });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 11, outputTokens: 3, cachedTokens: null });
  });

  it("成功时写一条 ok 日志，带 usage 与来源", async () => {
    respondSse([
      { choices: [{ delta: { content: "ok" } }] },
      {
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } },
      },
    ]);

    expect(await chatStream("summary", [], undefined, { source: SOURCE, onUsage })).toBe("ok");
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({
      source: SOURCE,
      task: "summary",
      status: "ok",
      errorCode: "",
      usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 400 },
    });
    expect(recorded.calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 1000, outputTokens: 200, cachedTokens: 400 });
    expect(onUsage.mock.calls[0]![0]).not.toBe(recorded.calls[0]!.usage);
  });

  it("HTTP 400 降级非流式后成功，只写一条 ok 日志", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    expect(await chatStream("summary", [], undefined, { source: SOURCE, onUsage })).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok" });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 5, outputTokens: 1, cachedTokens: null });
  });

  it("上游不返回 usage 时三个 token 字段为 null，日志仍写一条", async () => {
    respondSse([{ choices: [{ delta: { content: "ok" } }] }]);

    await chatStream("summary", [], undefined, { source: SOURCE, onUsage });
    expect(recorded.calls[0]).toMatchObject({
      status: "ok",
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
    });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: null, outputTokens: null, cachedTokens: null });
  });

  it("重试耗尽后写一条 failed 日志，带 error_code 与 attempts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    vi.useFakeTimers();
    try {
      const run = chatStream("summary", [], undefined, { source: SOURCE, onUsage }).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await run).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "http_503", attempts: 2 });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: null, outputTokens: null, cachedTokens: null });
  });

  it("客户端取消时写一条 cancelled 日志", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => Promise.resolve(
      new Response(new ReadableStream({ start(stream) {
        options.signal!.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } })
    )));

    // 必须等 chatStream 已经发起 fetch（即 abort 监听器已注册）之后再取消，
    // 否则前置的 signal.throwIfAborted() 会先抛错，那条路径不写日志。
    const run = chatStream("summary", [], undefined, { signal: controller.signal, source: SOURCE, onUsage });
    const outcome = run.then(() => null, (error: unknown) => error);
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: null, outputTokens: null, cachedTokens: null });
  });

  it("未配置模型时前置失败不写日志", async () => {
    settings.base_url = "";
    await expect(chatStream("summary", [], undefined, { source: SOURCE, onUsage })).rejects.toThrow();
    expect(recorded.calls).toHaveLength(0);
    expect(onUsage).not.toHaveBeenCalled();
    settings.base_url = "https://model.invalid/v1";
  });

  it("未传 source 时不写日志", async () => {
    respondSse([{ choices: [{ delta: { content: "ok" } }] }]);
    expect(await chatStream("summary", [], undefined, { onUsage })).toBe("ok");
    expect(recorded.calls).toHaveLength(0);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: null, outputTokens: null, cachedTokens: null });
  });

  it.each(["input", "invalid-url", "aborted"] as const)("%s 前置失败没有终态用量观察", async kind => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const controller = new AbortController();
    if (kind === "aborted") controller.abort();
    if (kind === "invalid-url") settings.base_url = "file:///synthetic";
    const messages = kind === "input" ? [{ role: "user" as const, content: "x".repeat(MAX_MODEL_INPUT_CHARS + 1) }] : [];
    await expect(chatStream("summary", messages, undefined, { source: SOURCE, signal: controller.signal, onUsage })).rejects.toThrow();
    expect(upstream).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
    expect(recorded.calls).toHaveLength(0);
  });

  it.each(["success", "output-limit", "network", "invalid-json"] as const)("JSON重试后%s只观察一次累计量，未知尝试不补0", async terminal => {
    const withUsage = (content: string, inputTokens: number, outputTokens: number) => sseResponse([
      { choices: [{ delta: { content } }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } },
    ]);
    const upstream = vi.fn().mockResolvedValueOnce(withUsage("invalid", 10, 3));
    if (terminal === "success") upstream.mockResolvedValueOnce(withUsage('{"ok":true}', 20, 5));
    else if (terminal === "output-limit") upstream.mockResolvedValueOnce(sseResponse([
      { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } },
      { choices: [], usage: { prompt_tokens: 999, completion_tokens: 999 } },
    ]));
    else if (terminal === "network") upstream.mockRejectedValue(new TypeError("synthetic network failure"));
    else upstream.mockImplementation(async () => withUsage("invalid", 20, 5));
    vi.stubGlobal("fetch", upstream);
    vi.useFakeTimers();
    const outcome = chatStream("summary", [], undefined, { source: SOURCE, requireJson: "strict", onUsage })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await outcome;
    const expected = terminal === "network"
      ? { inputTokens: 10, outputTokens: 3, cachedTokens: null }
      : terminal === "invalid-json"
        ? { inputTokens: 50, outputTokens: 13, cachedTokens: null }
        : { inputTokens: 30, outputTokens: 8, cachedTokens: terminal === "output-limit" ? 0 : null };
    if (terminal === "success") expect(result).toEqual({ value: '{"ok":true}' });
    else expect(result).toHaveProperty("error");
    if (terminal === "output-limit") expect(result).toMatchObject({ error: { code: "incomplete", reason: "output_limit", usage: expected } });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expected);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: terminal === "success" ? "ok" : "failed", usage: expected });
    expect(upstream).toHaveBeenCalledTimes(terminal === "network" || terminal === "invalid-json" ? 3 : 2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("退避中取消保留前次已知用量，只通知最终一次", async () => {
    const controller = new AbortController();
    respondSse([{ choices: [{ delta: { content: "invalid" } }], usage: { prompt_tokens: 4, completion_tokens: 0 } }]);
    vi.useFakeTimers();
    const outcome = chatStream("summary", [], undefined, { source: SOURCE, requireJson: "strict", signal: controller.signal, onUsage })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(onUsage).not.toHaveBeenCalled();
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 4, outputTokens: 0, cachedTokens: null });
    expect(fetch).toHaveBeenCalledOnce();
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "cancelled", usage: { inputTokens: 4, outputTokens: 0, cachedTokens: null } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("流读取超时耗尽重试时仍观察已收到的累计用量", async () => {
    const upstream = vi.fn((_url: string, options: RequestInit) => Promise.resolve(new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 0 } })}\n\n`));
        options.signal!.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } })));
    vi.stubGlobal("fetch", upstream);
    vi.useFakeTimers();
    const outcome = chatStream("summary", [], undefined, { source: SOURCE, onUsage }).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(190_000);
    expect(await outcome).toMatchObject({ name: "Error", message: expect.stringContaining("未收到新数据") });
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 6, outputTokens: 0, cachedTokens: null });
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "timeout", usage: { inputTokens: 6, outputTokens: 0, cachedTokens: null } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throw", "reject", "pending", "mutate"] as const)("%s用量观察者不改变成功回复或真实计量，也不会等待", async behavior => {
    respondSse([{ choices: [{ delta: { content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 0 } }]);
    onUsage.mockImplementation(usage => {
      usage.inputTokens = 999;
      usage.outputTokens = 999;
      if (behavior === "throw") throw new Error("synthetic observer");
      if (behavior === "reject") return Promise.reject(new Error("synthetic observer"));
      if (behavior === "pending") return new Promise<void>(() => {});
    });
    expect(await chatStream("summary", [], undefined, { source: SOURCE, onUsage })).toBe("ok");
    expect(onUsage).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", usage: { inputTokens: 12, outputTokens: 0, cachedTokens: null } });
  });

  it("失败观察者修改副本并抛错不改变typed错误和累计用量", async () => {
    respondSse([{ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 7, completion_tokens: 2 } }]);
    onUsage.mockImplementation(usage => {
      usage.outputTokens = 999;
      throw new Error("synthetic observer");
    });
    await expect(chatStream("summary", [], undefined, { source: SOURCE, onUsage })).rejects.toMatchObject({
      name: "LlmResponseError", code: "incomplete", reason: "output_limit", usage: { inputTokens: 7, outputTokens: 2, cachedTokens: null },
    });
    expect(onUsage).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", usage: { inputTokens: 7, outputTokens: 2, cachedTokens: null } });
  });
});
