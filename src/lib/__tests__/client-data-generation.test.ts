import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("客户端数据世代", () => {
  it("JSON 请求固定文档世代，不从后台响应或后续 DOM 更新采用新世代", async () => {
    const meta = { content: "before-restore" };
    vi.stubGlobal("document", { querySelector: () => meta });
    const fetch = vi.fn(async () => Response.json({ ok: true }, { headers: { "X-Resume-Life-Data-Generation": "after-restore" } }));
    vi.stubGlobal("fetch", fetch);
    const { jsonFetch } = await import("@/lib/fetcher");
    await jsonFetch("/api/projects");
    meta.content = "after-restore";
    await jsonFetch("/api/projects/1", { method: "DELETE" });
    for (const call of fetch.mock.calls) {
      expect(new Headers((call as unknown as [string, RequestInit])[1].headers).get("X-Resume-Life-Data-Generation")).toBe("before-restore");
    }
  });

  it("流式写入也携带文档世代并保留调用方头", async () => {
    vi.stubGlobal("document", { querySelector: () => ({ content: "initial" }) });
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { fetchSse } = await import("@/lib/fetch-sse");
    await fetchSse("/api/projects/1/summarize", { headers: { "X-Custom": "value" }, body: {} });
    const headers = new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get("X-Resume-Life-Data-Generation")).toBe("initial");
    expect(headers.get("X-Custom")).toBe("value");
  });

  it("文件请求保留 FormData、取消信号和原始响应，不设置 multipart 边界", async () => {
    vi.stubGlobal("document", { querySelector: () => ({ content: "initial" }) });
    const response = new Response("attachment");
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    const { apiFetch } = await import("@/lib/api-fetch");
    const body = new FormData();
    body.set("file", new Blob(["data"]), "test.txt");
    const { signal } = new AbortController();
    expect(await apiFetch("/api/upload", { method: "POST", body, signal })).toBe(response);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe(body);
    expect(init.signal).toBe(signal);
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    expect(new Headers(init.headers).get("X-Resume-Life-Data-Generation")).toBe("initial");
  });

  it.each(["/api/auth/login", "https://external.example/api/upload", "//external.example/api/upload"])("不向 %s 附加文档世代", async (url) => {
    vi.stubGlobal("document", { querySelector: () => ({ content: "initial" }) });
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { apiFetch } = await import("@/lib/api-fetch");
    await apiFetch(url, { method: "POST" });
    expect(new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).has("X-Resume-Life-Data-Generation")).toBe(false);
  });
});
