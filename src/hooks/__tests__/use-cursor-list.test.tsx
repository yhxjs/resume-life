// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorList } from "../use-cursor-list";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("useCursorList request lifecycle", () => {
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
