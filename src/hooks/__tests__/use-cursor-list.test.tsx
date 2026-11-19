// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorList } from "../use-cursor-list";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useCursorList request lifecycle", () => {
  it("旧加载更多回调再次使用时读取最新已确认边界，不能重投已消费页", async () => {
    const fetch = vi.fn(async (raw: string) => {
      const cursor = new URL(raw, "http://localhost").searchParams.get("cursor");
      return Response.json(cursor === "1" ? { items: ["second"], nextCursor: "2" } : cursor === "2" ? { items: ["third"], nextCursor: null } : { items: ["first"], nextCursor: "1" });
    });
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(() => useCursorList<string>({ queryKey: "test", delay: 0, buildUrl: cursor => `/api/items${cursor ? `?cursor=${cursor}` : ""}` }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    const savedLoadMore = hook.result.current.loadMore;
    await act(async () => savedLoadMore());
    await act(async () => savedLoadMore());
    await act(async () => savedLoadMore()); // 末页后旧回调同样不能重新发请求。
    expect(hook.result.current.items).toEqual(["first", "second", "third"]);
    expect(fetch.mock.calls.slice(1).map(([url]) => new URL(url, "http://localhost").searchParams.get("cursor"))).toEqual(["1", "2"]);
  });

  it("已切换查询后旧加载更多回调不能请求旧来源或污染新列表", async () => {
    const fetch = vi.fn(async (raw: string) => {
      const params = new URL(raw, "http://localhost").searchParams;
      return Response.json(params.has("cursor") ? { items: ["old-second"], nextCursor: null } : { items: [params.get("q")], nextCursor: "1" });
    });
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(({ query }) => useCursorList<string>({ queryKey: query, delay: 10, buildUrl: cursor => `/api/items?q=${query}${cursor ? `&cursor=${cursor}` : ""}` }), { initialProps: { query: "old" } });
    await act(() => vi.advanceTimersByTimeAsync(10));
    const savedLoadMore = hook.result.current.loadMore;
    hook.rerender({ query: "new" });
    await act(() => vi.advanceTimersByTimeAsync(10));
    await act(async () => savedLoadMore());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hook.result.current.items).toEqual(["new"]);
  });

  it("领域校验在首屏及续页应用前执行，坏条目不能部分写入且可重试原游标", async () => {
    const validatePage = vi.fn((page: { items: string[] }, cursor?: string) => {
      if (page.items.includes("bad")) throw new Error(`领域记录损坏：${cursor ?? "首页"}`);
    });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ items: ["bad"], nextCursor: "bad", total: 99 }))
      .mockResolvedValueOnce(Response.json({ items: ["first"], nextCursor: "1", total: 2 }))
      .mockResolvedValueOnce(Response.json({ items: ["good", "bad"], nextCursor: null }))
      .mockResolvedValueOnce(Response.json({ items: ["second"], nextCursor: null }));
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(() => useCursorList<string>({ queryKey: "test", delay: 0, buildUrl: cursor => `/api/items?cursor=${cursor ?? ""}`, validatePage }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(hook.result.current.items).toBeNull(); expect(hook.result.current.total).toBeNull(); expect(hook.result.current.nextCursor).toBeNull();
    expect(hook.result.current.listError).toBe("领域记录损坏：首页");
    act(() => hook.result.current.reload()); await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => hook.result.current.loadMore());
    expect(hook.result.current.items).toEqual(["first"]); expect(hook.result.current.total).toBe(2); expect(hook.result.current.nextCursor).toBe("1");
    expect(hook.result.current.failedCursor).toBe("1"); expect(hook.result.current.listError).toBe("领域记录损坏：1");
    await act(async () => hook.result.current.loadMore()); expect(hook.result.current.items).toEqual(["first", "second"]);
    expect(validatePage.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, undefined, "1", "1"]);
    expect(fetch.mock.calls[2]?.[0]).toBe(fetch.mock.calls[3]?.[0]);
    expect(fetch.mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it.each(["query", "reload"])("%s 首屏等待与失败均不能重新暴露旧列表", async (action) => {
    const response = Promise.withResolvers<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ items: ["old"], nextCursor: "1", total: 2 }))
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(Response.json({ items: ["new"], nextCursor: null, total: 1 }));
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(({ query }) => useCursorList<string>({ queryKey: query, delay: 10, buildUrl: () => `/api/items?q=${query}` }), { initialProps: { query: "old" } });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(hook.result.current.items).toEqual(["old"]);
    if (action === "query") hook.rerender({ query: "new" });
    else act(() => hook.result.current.reload());
    expect(hook.result.current.items).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(hook.result.current.items).toBeNull();
    expect(hook.result.current.nextCursor).toBeNull();
    await act(async () => response.resolve(Response.json({ error: "新查询失败" }, { status: 503 })));
    expect(hook.result.current.items).toBeNull();
    expect(hook.result.current.listError).toBe("新查询失败");
    expect(hook.result.current.failedCursor).toBeNull();
    act(() => hook.result.current.reload());
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(hook.result.current.items).toEqual(["new"]);
  });

  it.each([{ items: null, nextCursor: null }, { items: [], nextCursor: {} }, { items: [], nextCursor: null, total: -1 }])("首屏异常分页响应整页拒绝，不部分写入状态 %#", async (page) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(page)));
    const hook = renderHook(() => useCursorList<string>({ queryKey: "test", delay: 0, buildUrl: () => "/api/items" }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(hook.result.current.items).toBeNull();
    expect(hook.result.current.total).toBeNull();
    expect(hook.result.current.nextCursor).toBeNull();
    expect(hook.result.current.listError).toContain("分页响应");
    expect(hook.result.current.failedCursor).toBeNull();
  });

  it.each([
    { items: null, nextCursor: null }, { items: ["bad"], nextCursor: "" },
    { items: ["repeat"], nextCursor: "1" }, { items: ["bad"], nextCursor: null, total: 1.5 },
  ])("加载更多异常保留已有内容和原游标，显式重试不重复追加 %#", async (invalid) => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ items: ["first"], nextCursor: "1", total: 3 }))
      .mockResolvedValueOnce(Response.json(invalid))
      .mockResolvedValueOnce(Response.json({ items: ["second"], nextCursor: "2" }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useCursorList<string>({ queryKey: "test", delay: 0, buildUrl: (cursor) => `/api/items${cursor ? `?cursor=${cursor}` : ""}` }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual(["first"]);
    expect(result.current.total).toBe(3);
    expect(result.current.nextCursor).toBe("1");
    expect(result.current.failedCursor).toBe("1");
    expect(result.current.listError).toContain("分页响应");
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual(["first", "second"]);
    expect(fetch.mock.calls[1]?.[0]).toBe(fetch.mock.calls[2]?.[0]);
  });

  it("拒绝回到更早游标的循环，刷新后允许重新加载原游标", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ items: ["first"], nextCursor: "1" }))
      .mockResolvedValueOnce(Response.json({ items: ["second"], nextCursor: "2" }))
      .mockResolvedValueOnce(Response.json({ items: ["third"], nextCursor: "1" }))
      .mockResolvedValueOnce(Response.json({ items: ["refreshed"], nextCursor: "1" }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useCursorList<string>({ queryKey: "test", delay: 0, buildUrl: (cursor) => `/api/items?cursor=${cursor ?? ""}` }));
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => result.current.loadMore());
    await act(async () => result.current.loadMore());
    expect(result.current.items).toEqual(["first", "second"]);
    expect(result.current.failedCursor).toBe("2");
    expect(result.current.listError).toContain("游标未前进");
    act(() => result.current.reload());
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.items).toEqual(["refreshed"]);
    expect(result.current.nextCursor).toBe("1");
  });

  it("同一事件刷新后旧加载更多命令不再发请求", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ items: ["first"], nextCursor: "1" }));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useCursorList<string>({ queryKey: "test", delay: 10, buildUrl: (cursor) => `/api/items?cursor=${cursor ?? ""}` }));
    await act(() => vi.advanceTimersByTimeAsync(10));
    act(() => { result.current.reload(); result.current.loadMore(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  async function setup() {
    let signal: AbortSignal | undefined;
    let resolvePage!: (value: Response) => void;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("cursor=")) {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolvePage = resolve; });
      }
      return Response.json({ items: [url], nextCursor: "1", total: 2 });
    });
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(({ query }) => useCursorList<string>({
      queryKey: query,
      delay: 10,
      buildUrl: (cursor) => `/api/items?q=${query}${cursor ? `&cursor=${cursor}` : ""}`,
    }), { initialProps: { query: "old" } });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(hook.result.current.hasMore).toBe(true);
    act(() => hook.result.current.loadMore());
    expect(signal?.aborted).toBe(false);
    return { hook, signal, resolvePage, fetch };
  }

  it("aborts a pending pagination request on unmount", async () => {
    const { hook, signal, resolvePage } = await setup();
    hook.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolvePage(Response.json({ items: ["late"], nextCursor: null })); });
  });

  it("ignores a late old page after the query changes", async () => {
    const { hook, signal, resolvePage } = await setup();
    hook.rerender({ query: "new" });
    expect(signal?.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(10));
    await act(async () => { resolvePage(Response.json({ items: ["late"], nextCursor: null })); });
    expect(hook.result.current.items).toEqual(["/api/items?q=new"]);
    expect(hook.result.current.loadingMore).toBe(false);
  });

  it("keeps pagination single-flight and appends a successful page", async () => {
    const { hook, resolvePage, fetch } = await setup();
    act(() => hook.result.current.loadMore());
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { resolvePage(Response.json({ items: ["second"], nextCursor: null })); });
    expect(hook.result.current.items).toEqual(["/api/items?q=old", "second"]);
    expect(hook.result.current.hasMore).toBe(false);
    expect(hook.result.current.loadingMore).toBe(false);
  });

  it("切换查询的防抖窗口不暴露旧结果或使用旧游标请求新查询", async () => {
    const { hook, resolvePage, fetch } = await setup();
    await act(async () => resolvePage(Response.json({ items: ["second"], nextCursor: "2" })));
    hook.rerender({ query: "new" });
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.items).toBeNull();
    expect(hook.result.current.nextCursor).toBeNull();
    act(() => hook.result.current.loadMore());
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(hook.result.current.items).toEqual(["/api/items?q=new"]);
    expect(hook.result.current.nextCursor).toBe("1");
  });

  it("reload 在防抖窗口立即使旧完整结果失效", async () => {
    const { hook, resolvePage, fetch } = await setup();
    await act(async () => resolvePage(Response.json({ items: ["second"], nextCursor: null })));
    act(() => hook.result.current.reload());
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.items).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(hook.result.current.loading).toBe(false);
  });
});
