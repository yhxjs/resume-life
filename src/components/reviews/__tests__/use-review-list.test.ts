// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReviewList } from "../use-review-list";
import { jsonFetch } from "@/lib/fetcher";
import { addReviewDays, getReviewDate } from "@/lib/spaced-repetition";
import type { ReviewList, ReviewListCard } from "@/lib/spaced-repetition-card-types";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const date = getReviewDate();
const card = (id: number): ReviewListCard => ({ id, source: "notebook", source_id: id, source_label: "错题", question: `题目 ${id}`, mastery: "new", interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: date, sort_date: date, last_reviewed_at: "" });
const cursor = (id: number) => Buffer.from(JSON.stringify({ updatedAt: date, id })).toString("base64url");
const page = (ids: number[], nextCursor: string | null = null): ReviewList => ({ items: ids.map(card), nextCursor, summary: { date, total: 5, due: 5, notebook: 5, remedial: 0, overdue: 0, completed_today: 0 } });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe("复习列表真实 React 请求生命周期", () => {
  it("请求带浏览器时区、分页上限并禁用缓存", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(page([1]));
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 3 }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    const [raw, init] = vi.mocked(jsonFetch).mock.calls[0]!;
    const url = new URL(raw, "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "due", source: "all", limit: "3", time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(init).toMatchObject({ cache: "no-store" }); expect(hook.result.current.data).toEqual(page([1]));
  });

  it("分页失败保留原游标，同一事件重复点击只发一次；重试清除错误", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([1], cursor(1))).mockRejectedValueOnce(new Error("翻页失败")).mockResolvedValueOnce(page([2]));
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 1 }));
    await waitFor(() => expect(hook.result.current.data).not.toBeNull());
    await act(async () => { await Promise.all([hook.result.current.loadMore(), hook.result.current.loadMore()]); });
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(hook.result.current.error).toBe("翻页失败");
    expect(hook.result.current.data?.nextCursor).toBe(cursor(1));
    await act(() => hook.result.current.loadMore());
    expect(hook.result.current.data?.items.map(item => item.id)).toEqual([1, 2]); expect(hook.result.current.error).toBe("");
    expect(vi.mocked(jsonFetch).mock.calls.slice(1).every(([url]) => new URL(url, "http://localhost").searchParams.get("cursor") === cursor(1))).toBe(true);
  });

  it("切换筛选立即隔离旧内容，迟到分页不能覆盖新筛选", async () => {
    const pending = deferred<ReviewList>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([1], cursor(1))).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([3]));
    const hook = renderHook(({ source }: { source: "all" | "notebook" }) => useReviewList({ scope: "due", source, limit: 1 }), { initialProps: { source: "all" } });
    await waitFor(() => expect(hook.result.current.data).not.toBeNull());
    let load!: Promise<void>; act(() => { load = hook.result.current.loadMore(); });
    hook.rerender({ source: "notebook" }); expect(hook.result.current.data).toBeNull(); expect(hook.result.current.loading).toBe(true);
    await waitFor(() => expect(hook.result.current.data?.items[0]?.id).toBe(3));
    await act(async () => { pending.resolve(page([2])); await load; });
    expect(hook.result.current.data?.items.map(item => item.id)).toEqual([3]);
    expect(vi.mocked(jsonFetch).mock.calls[1]![1]?.signal?.aborted).toBe(true);
  });

  it("刷新保留已加载页数，真实向后移动的卡更新并移到正确位置", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([1, 2], cursor(2))).mockResolvedValueOnce(page([3]));
    const hook = renderHook(() => useReviewList({ scope: "all", source: "all", limit: 2 }));
    await waitFor(() => expect(hook.result.current.data).not.toBeNull()); await act(() => hook.result.current.loadMore());
    const moved = { ...card(1), review_count: 1, repetitions: 1, mastery: "learning" as const, sort_date: addReviewDays(date, 1), next_review_date: addReviewDays(date, 1) };
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([1, 2], cursor(2))).mockResolvedValueOnce({ ...page([3]), items: [card(3), moved] });
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(jsonFetch).toHaveBeenCalledTimes(4); expect(hook.result.current.data?.items.map(item => item.id)).toEqual([2, 3, 1]);
    expect(hook.result.current.data?.items.at(-1)?.review_count).toBe(1);
  });

  it("刷新批次的后页失败整批保留，重试仍重新读取全部已加载页", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([1], cursor(1))).mockResolvedValueOnce(page([2]));
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 1 }));
    await waitFor(() => expect(hook.result.current.data).not.toBeNull()); await act(() => hook.result.current.loadMore());
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([3], cursor(3))).mockRejectedValueOnce(new Error("第二页失败"));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.error).toBe("第二页失败"));
    expect(hook.result.current.data?.items.map(item => item.id)).toEqual([1, 2]);
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([3], cursor(3))).mockResolvedValueOnce(page([4]));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.data?.items.map(item => item.id)).toEqual([3, 4]));
  });

  it("reload 同步中止分页，迟到响应及紧接着的加载更多均不能写入", async () => {
    const pending = deferred<ReviewList>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([1], cursor(1))).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page([3]));
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 1 }));
    await waitFor(() => expect(hook.result.current.data).not.toBeNull());
    let load!: Promise<void>; act(() => { load = hook.result.current.loadMore(); hook.result.current.reload(); void hook.result.current.loadMore(); });
    await act(async () => { pending.resolve(page([2])); await load; });
    await waitFor(() => expect(hook.result.current.data?.items.map(item => item.id)).toEqual([3])); expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it("离页取消首页和续页请求", async () => {
    const pending = deferred<ReviewList>(); vi.mocked(jsonFetch).mockResolvedValueOnce(page([1], cursor(1))).mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 1 }));
    await waitFor(() => expect(hook.result.current.data).not.toBeNull());
    let load!: Promise<void>; act(() => { load = hook.result.current.loadMore(); }); hook.unmount();
    expect(vi.mocked(jsonFetch).mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await act(async () => { pending.resolve(page([2])); await load; });
  });

  it("同一事件连续读取两页也使用最新边界，不丢已确认的中间页", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(page([1], cursor(1))).mockResolvedValueOnce(page([2], cursor(2))).mockResolvedValueOnce(page([3]));
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 1 }));
    await waitFor(() => expect(hook.result.current.data).not.toBeNull());
    await act(async () => { await hook.result.current.loadMore(); await hook.result.current.loadMore(); });
    expect(hook.result.current.data?.items.map(item => item.id)).toEqual([1, 2, 3]);
    expect(vi.mocked(jsonFetch).mock.calls.slice(1).map(([url]) => new URL(url, "http://localhost").searchParams.get("cursor"))).toEqual([cursor(1), cursor(2)]);
  });
});
