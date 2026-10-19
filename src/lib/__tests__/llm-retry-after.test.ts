import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings", () => ({ readSettings: () => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }) }));
import { chat } from "../llm";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T12:00:00Z"));
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function succeed() {
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
}

describe("LLM Retry-After", () => {
  it.each([
    [429, "5", 5000],
    [503, "Sun, 11 Oct 2026 12:00:08 GMT", 8000],
    [429, "Sunday, 11-Oct-26 12:00:08 GMT", 8000],
    [429, "Sun Oct 11 12:00:08 2026", 8000],
    [429, "0", 1000],
    [429, "Sun, 11 Oct 2026 11:59:00 GMT", 1000],
    [429, "invalid", 1000],
    [429, "Sun, 31 Feb 2027 12:00:08 GMT", 1000],
    [429, "Foo, 11 Oct 2026 12:00:08 GMT", 1000],
    [429, "Mon, 11 Oct 2026 12:00:08 GMT", 1000],
    [429, "1.5", 1000],
    [429, "-1", 1000],
    [429, null, 1000],
  ])("HTTP %s 的 %s 至少等待 %s ms", async (status, retryAfter, wait) => {
    const upstream = vi.fn().mockResolvedValueOnce(new Response(null, {
      status, headers: retryAfter === null ? {} : { "Retry-After": retryAfter },
    })).mockResolvedValueOnce(succeed());
    vi.stubGlobal("fetch", upstream);
    const controller = new AbortController();
    const result = chat("parse", [], { signal: controller.signal });
    const outcome = result.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(upstream).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(await result).toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      await outcome;
    }
  });

  it("长 Retry-After 不会越过总截止时间后提前重试", async () => {
    const upstream = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "86400" } })).mockResolvedValue(succeed());
    vi.stubGlobal("fetch", upstream);
    const result = chat("parse", []).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_203_000);
    expect(await result).toBeInstanceOf(Error);
    expect((await result as Error).message).toContain("超时");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("供应商等待期间取消立即结束，不发出额外请求", async () => {
    const upstream = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } })).mockResolvedValue(succeed());
    vi.stubGlobal("fetch", upstream);
    const controller = new AbortController();
    const result = chat("parse", [], { signal: controller.signal }).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
