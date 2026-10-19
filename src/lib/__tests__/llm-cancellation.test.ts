import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
import { chat } from "../llm";

beforeEach(() => { settings.api_format = "openai_chat"; vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("模型取消生命周期", () => {
  it("预中止时不发出请求", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetch);
    await expect(chat("parse", [], { signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("请求中取消立即结束且不重试", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    vi.stubGlobal("fetch", fetch);
    const run = chat("parse", [], { signal: controller.signal });
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("退避期间取消清除等待且不发起下一次请求", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn().mockRejectedValue(new Error("temporary")); vi.stubGlobal("fetch", fetch);
    const run = chat("parse", [], { signal: controller.signal });
    const rejection = expect(run).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("正常暂时错误仍可重试成功", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
    vi.stubGlobal("fetch", fetch);
    const run = chat("parse", []);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Responses 拒绝 stream 后非流式回退读取原始 output_text", async () => {
    settings.api_format = "openai_responses";
    const fetch = vi.fn().mockResolvedValueOnce(new Response("stream unsupported", { status: 400 }))
      .mockResolvedValueOnce(Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await chat("parse", [])).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).stream).toBe(true);
    expect(JSON.parse(fetch.mock.calls[1]![1].body).stream).toBeUndefined();
  });
});
