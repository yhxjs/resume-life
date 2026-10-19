import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
vi.mock("../settings", () => ({ readSettings: () => settings }));

import { chat, LlmConfigError, LLM_MAX_CONCURRENT } from "../llm";

/**
 * 用挂起的上游请求占满进程级名额，验证超限调用立即拒绝且不新增 HTTP 请求，
 * 以及前一批调用结束后名额可以再次使用。实体级命令锁只去重，不替代总量上限。
 */

const OK_BODY = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

/**
 * 挂住前 N 个请求，返回放行句柄。
 *
 * 闸门计数是模块级的，一条用例结束时若还有调用挂在闸门里，后面的用例会看到
 * 一个被占满的闸门、在毫不相干的地方报错。所以每条用例都必须放行并等它们结束。
 */
function pendingFetch() {
  const releases: (() => void)[] = [];
  const fetch = vi.fn((_url: string, options: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      releases.push(() => resolve(new Response(OK_BODY)));
      options.signal?.addEventListener(
        "abort",
        () => reject(options.signal!.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true }
      );
    })
  );
  vi.stubGlobal("fetch", fetch);
  return { fetch, releaseAll: () => releases.splice(0).forEach((release) => release()) };
}

function okFetch() {
  const fetch = vi.fn().mockResolvedValue(new Response(OK_BODY));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  settings.api_format = "openai_chat";
  settings.api_key = "synthetic";
  // 日志通道是 logServerEvent("info", ...) → console.info，不是 console.log
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LLM 并发闸门", () => {
  it("达到上限时立即失败，且不发出第 4 个 HTTP 请求", async () => {
    const { fetch, releaseAll } = pendingFetch();
    const running = Array.from({ length: LLM_MAX_CONCURRENT }, () => chat("parse", []));

    await expect(chat("parse", [])).rejects.toThrow(/同时进行的模型调用过多/);
    expect(fetch).toHaveBeenCalledTimes(LLM_MAX_CONCURRENT);

    releaseAll();
    await Promise.all(running);
  });

  it("不带 source 的一批成功调用结束后仍可再次调用", async () => {
    const { fetch, releaseAll } = pendingFetch();
    const running = Array.from({ length: LLM_MAX_CONCURRENT }, () => chat("parse", []));
    releaseAll();
    await Promise.all(running);

    const ok = okFetch();
    expect(await chat("parse", [])).toBe("ok");
    expect(ok).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(LLM_MAX_CONCURRENT);
  });

  it("配置校验失败的调用也归还名额，不会把闸门永久占满", async () => {
    settings.api_key = "";
    const failedFetch = vi.fn();
    vi.stubGlobal("fetch", failedFetch);
    // 缺失配置在占用名额后失败，尚未发 HTTP 请求，因此不涉及网络重试。
    const results = await Promise.allSettled(Array.from({ length: LLM_MAX_CONCURRENT }, () => chat("parse", [])));
    expect(failedFetch).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(LlmConfigError);
        expect(result.reason.message).toContain("尚未配置好");
      }
    }

    settings.api_key = "synthetic";
    const { fetch, releaseAll } = pendingFetch();
    const recovered = Array.from({ length: LLM_MAX_CONCURRENT }, () => chat("parse", []));
    const completed = Promise.allSettled(recovered);
    try {
      expect(fetch).toHaveBeenCalledTimes(LLM_MAX_CONCURRENT);
    } finally {
      releaseAll();
    }
    expect(await completed).toEqual(Array.from({ length: LLM_MAX_CONCURRENT }, () => ({ status: "fulfilled", value: "ok" })));
  });
});
