import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, jsonFetch } from "../fetcher";

async function rejectionOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

afterEach(() => vi.unstubAllGlobals());

describe("jsonFetch", () => {
  it("422 响应抛出带状态码并保留合法服务端消息原文的 HttpError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: "  请求参数无效  " }, { status: 422 }),
    ));

    const error = await rejectionOf(jsonFetch("/mock"));

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ message: "  请求参数无效  ", status: 422 });
  });

  it("503 响应没有可用 JSON error 时回退到 HTTP 状态消息", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("Service unavailable", { status: 503 }),
    ));

    const error = await rejectionOf(jsonFetch("/mock"));

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ message: "HTTP 503", status: 503 });
  });

  it.each([
    { errorValue: "   ", label: "空白字符串" },
    { errorValue: 42, label: "非字符串" },
  ])("error 为$label时回退到 HTTP 状态消息", async ({ errorValue }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: errorValue }, { status: 503 }),
    ));

    const error = await rejectionOf(jsonFetch("/mock"));

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ message: "HTTP 503", status: 503 });
  });

  it("fetch 拒绝 AbortError 时原样抛出", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    await expect(jsonFetch("/mock")).rejects.toBe(abortError);
  });

  it("普通网络 Error 转换为中文连接错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    await expect(jsonFetch("/mock")).rejects.toThrow(
      "无法连接服务器：应用可能正在重启，请稍等几秒后重试",
    );
  });

  it("2xx JSON 响应正常返回", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ ok: true, value: 42 }),
    ));

    await expect(jsonFetch<{ ok: boolean; value: number }>("/mock")).resolves.toEqual({
      ok: true,
      value: 42,
    });
  });

  it.each(["<html>服务器正在重启</html>", "", "null"])("2xx 无可用 JSON 数据时抛出可展示错误：%s", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(jsonFetch("/mock")).rejects.toThrow("服务器返回的数据无法读取，请重试");
  });

  it("当提供 body 且未显式指定 Content-Type 时，默认注入 application/json", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await jsonFetch("/mock", {
      method: "POST",
      body: JSON.stringify({ resumeId: 1 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("当调用方已显式指定 Content-Type 时，保留原 Content-Type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await jsonFetch("/mock", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ resumeId: 1 }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });
});
