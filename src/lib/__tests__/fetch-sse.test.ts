import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSse } from "../fetch-sse";

function stream(chunks: string[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
afterEach(() => vi.unstubAllGlobals());

describe("SSE 完成与错误边界", () => {
  it("跨块、CRLF、纯文本 delta 与末尾 done 均可处理", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream([
      "event: del", "ta\r\ndata: {\"text\":\"你\"}\r\n\r\nevent: delta\ndata: 好\n\n",
      "event: done\ndata: {\"id\":1}",
    ])));
    const delta = vi.fn(); const done = vi.fn();
    await fetchSse("/mock", { onDelta: delta, onDone: done });
    expect(delta.mock.calls.map((call) => call[0]).join("")).toBe("你好");
    expect(done).toHaveBeenCalledWith({ id: 1 });
  });

  it("缺少 done/error 的 EOF 必须失败", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(["event: delta\ndata: {\"text\":\"半段\"}\n\n"])));
    const error = vi.fn();
    await expect(fetchSse("/mock", { onError: error })).rejects.toThrow(/中断|完成/);
    expect(error).toHaveBeenCalledOnce();
  });

  it("服务端 error 会拒绝 Promise 且只通知一次", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(["event: error\ndata: {\"error\":\"生成失败\"}\n\n"])));
    const error = vi.fn();
    await expect(fetchSse("/mock", { onError: error })).rejects.toThrow("生成失败");
    expect(error).toHaveBeenCalledOnce();
  });

  it.each([true, false])("等待完成回调，包括 JSON 降级 %j", async (sse) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse ? stream(["event: done\ndata: {}\n\n"]) : Response.json({})));
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    let finished = false;
    const run = fetchSse("/mock", { onDone: () => gate }).then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 0));
    const beforeRelease = finished;
    resolve(); await run;
    expect(beforeRelease).toBe(false);
  });

  it.each([true, false])("回调失败不得吞掉或变成 delta，SSE=%j", async (sse) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sse ? stream(["event: done\ndata: {}\n\n"]) : Response.json({})));
    const error = vi.fn();
    await expect(fetchSse("/mock", { onDone: () => { throw new Error("保存失败"); }, onError: error })).rejects.toThrow("保存失败");
    expect(error).toHaveBeenCalledOnce();
  });

  it("异步完成回调拒绝须传回调用者", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(["event: done\ndata: {}\n\n"])));
    const failure = Promise.reject(new Error("异步保存失败"));
    void failure.catch(() => {});
    await expect(fetchSse("/mock", { onDone: () => failure })).rejects.toThrow("异步保存失败");
  });

  it("delta 回调失败不重新发送原始 payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(["event: delta\ndata: {\"text\":\"x\"}\n\nevent: done\ndata: {}\n\n"])));
    const delta = vi.fn(() => { throw new Error("渲染失败"); });
    await expect(fetchSse("/mock", { onDelta: delta })).rejects.toThrow("渲染失败");
    expect(delta).toHaveBeenCalledOnce();
  });

  it("主动取消保持静默且不触发完成", async () => {
    const controller = new AbortController(); const done = vi.fn(); const error = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); }));
    await fetchSse("/mock", { signal: controller.signal, onDone: done, onError: error });
    expect(done).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it("非流式错误响应先看状态码：HTML 错误页不再报成 JSON 解析失败", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    })));
    const error = vi.fn();
    await expect(fetchSse("/mock", { onError: error })).rejects.toThrow("请求错误 HTTP 502");
    expect(error).toHaveBeenCalledOnce();
  });

  it("非流式错误响应带 JSON 正文时优先展示服务端错误文案", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "上游服务不可用" }, { status: 503 })));
    await expect(fetchSse("/mock", {})).rejects.toThrow("上游服务不可用");
  });

  it("读取流期间主动取消会释放 reader，保持原有静默取消约定", async () => {
    const controller = new AbortController(); const done = vi.fn(); const error = vi.fn(); const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n')); },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } })));
    await fetchSse("/mock", { signal: controller.signal, onDelta: () => controller.abort(), onDone: done, onError: error });
    expect(cancel).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
});
