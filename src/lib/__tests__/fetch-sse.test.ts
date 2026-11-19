import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSse } from "../fetch-sse";
import { HttpError } from "../fetcher";

function stream(chunks: string[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
afterEach(() => vi.unstubAllGlobals());

describe("SSE 完成与错误边界", () => {
  it.each([
    { status: 200, mediaType: "text/html", text: "<html>服务正在重启</html>" },
    { status: 200, mediaType: "application/json", text: '{"id":' },
    { status: 200, mediaType: "application/json", text: "" },
    { status: 204, mediaType: "application/json", text: null },
    { status: 200, mediaType: "text/plain", text: "upstream unavailable" },
  ])("HTTP $status 的无效 JSON 回退不能触发完成：$mediaType / $text", async ({ status, mediaType, text }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text, { status, headers: { "content-type": mediaType } })));
    const done = vi.fn(); const error = vi.fn(); const delta = vi.fn();
    const failure = await fetchSse("/mock", { onDone: done, onError: error, onDelta: delta }).catch(reason => reason);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("有效 JSON");
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(done).not.toHaveBeenCalled();
    expect(delta).not.toHaveBeenCalled();
  });

  it.each([null, {}, [], { id: 1 }, "正文", 3].map(payload => ({ payload })))("合法 JSON 回退 %# 原样交给业务完成回调", async ({ payload }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    const done = vi.fn(); const error = vi.fn();
    await fetchSse("/mock", { onDone: done, onError: error });
    expect(done).toHaveBeenCalledExactlyOnceWith(payload);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([true, false])("读取 JSON 回退期间取消，解析成功=%s 均不触发完成或错误", async valid => {
    const controller = new AbortController();
    const response = new Response();
    const parse = Promise.withResolvers<unknown>();
    vi.spyOn(response, "json").mockReturnValue(parse.promise);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const done = vi.fn(); const error = vi.fn();
    const run = fetchSse("/mock", { signal: controller.signal, onDone: done, onError: error });
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledOnce());
    controller.abort();
    if (valid) parse.resolve({ id: 1 });
    else parse.reject(new SyntaxError("JSON truncated"));
    await run;
    expect(done).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each(["application/json", "text/html", "text/event-stream"].flatMap(mediaType =>
    [400, 408, 409, 503].map(status => ({ mediaType, status }))))("$mediaType 的 HTTP $status 保留状态，只通知一次且不触发完成", async ({ mediaType, status }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(mediaType === "application/json" ? JSON.stringify({ error: "请求未被接受" }) : "upstream error", {
      status, headers: { "content-type": mediaType },
    })));
    const error = vi.fn(); const done = vi.fn();
    const failure = await fetchSse("/mock", { onError: error, onDone: done }).catch(reason => reason);
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure.status).toBe(status);
    expect(failure.message).toBe(mediaType === "application/json" ? "请求未被接受" : `请求错误 HTTP ${status}`);
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(done).not.toHaveBeenCalled();
  });

  it("合法服务端 error 事件保留独立错误类型，回调收到同一错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(['event: error\ndata: {"error":"材料已变化，请核对后重新生成"}\n\n'])));
    const error = vi.fn(); const done = vi.fn();
    const failure = await fetchSse("/mock", { onError: error, onDone: done }).catch(reason => reason);
    expect(failure.name).toBe("SseServerError");
    expect(failure.message).toBe("材料已变化，请核对后重新生成");
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(done).not.toHaveBeenCalled();
  });

  it.each([null, {}, [], "拒绝", { error: "" }, { error: "  " }, { error: 3 }].map(payload => ({ payload })))("损坏的服务端错误不是明确业务失败 %#", async ({ payload }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream([`event: error\ndata: ${JSON.stringify(payload)}\n\n`])));
    const error = vi.fn(); const done = vi.fn();
    const failure = await fetchSse("/mock", { onError: error, onDone: done }).catch(reason => reason);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).not.toBe("SseServerError");
    expect(error).toHaveBeenCalledExactlyOnceWith(failure);
    expect(done).not.toHaveBeenCalled();
  });
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
