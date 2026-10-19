import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmSource } from "../llm-source";

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

/**
 * chatStream 默认走流式（useStream = true），所以成功路径必须返回 SSE 正文。
 * 返回 JSON 会让 readSseContent 读不到 data: 行而抛「流式响应意外中断」。
 */
function respondSse(chunks: unknown[]) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })));
}

beforeEach(() => {
  recorded.calls.length = 0;
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
    await expect(chatStream("summary", [], () => controller.abort(), { source: SOURCE, signal: controller.signal })).rejects.toThrow();
    expect(recorded.calls[0]).toMatchObject({ status: "cancelled", usage: { inputTokens: 12, outputTokens: 2 } });
  });

  it("用量到达后流意外结束仍记录已报告的 token", async () => {
    const sse = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } })));
    await expect(chatStream("summary", [], undefined, { source: SOURCE })).rejects.toThrow();
    expect(recorded.calls[0]).toMatchObject({ status: "failed", usage: { inputTokens: 11, outputTokens: 3 } });
  });

  it("成功时写一条 ok 日志，带 usage 与来源", async () => {
    respondSse([
      { choices: [{ delta: { content: "ok" } }] },
      {
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } },
      },
    ]);

    expect(await chatStream("summary", [], undefined, { source: SOURCE })).toBe("ok");
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({
      source: SOURCE,
      task: "summary",
      status: "ok",
      errorCode: "",
      usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 400 },
    });
    expect(recorded.calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("HTTP 400 降级非流式后成功，只写一条 ok 日志", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    expect(await chatStream("summary", [], undefined, { source: SOURCE })).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok" });
  });

  it("上游不返回 usage 时三个 token 字段为 null，日志仍写一条", async () => {
    respondSse([{ choices: [{ delta: { content: "ok" } }] }]);

    await chatStream("summary", [], undefined, { source: SOURCE });
    expect(recorded.calls[0]).toMatchObject({
      status: "ok",
      usage: { inputTokens: null, outputTokens: null, cachedTokens: null },
    });
  });

  it("重试耗尽后写一条 failed 日志，带 error_code 与 attempts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    vi.useFakeTimers();
    try {
      const run = chatStream("summary", [], undefined, { source: SOURCE }).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await run).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "http_503", attempts: 2 });
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
    const run = chatStream("summary", [], undefined, { signal: controller.signal, source: SOURCE });
    const outcome = run.then(() => null, (error: unknown) => error);
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);

    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("未配置模型时前置失败不写日志", async () => {
    settings.base_url = "";
    await expect(chatStream("summary", [], undefined, { source: SOURCE })).rejects.toThrow();
    expect(recorded.calls).toHaveLength(0);
    settings.base_url = "https://model.invalid/v1";
  });

  it("未传 source 时不写日志", async () => {
    respondSse([{ choices: [{ delta: { content: "ok" } }] }]);
    expect(await chatStream("summary", [])).toBe("ok");
    expect(recorded.calls).toHaveLength(0);
  });
});
