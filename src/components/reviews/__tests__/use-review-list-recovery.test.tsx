// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReviewList } from "../use-review-list";
import { jsonFetch } from "@/lib/fetcher";
import { getReviewDate } from "@/lib/spaced-repetition";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const date = getReviewDate();
const card = (id: number) => ({ id, source: "notebook" as const, source_id: id, source_label: "完整来源", question: `原题 ${id} <T> &amp;\n内部  空格`, mastery: "learning" as const,
  interval_days: 1, ease_factor: 250, repetitions: 1, review_count: 1, lapses: 0, next_review_date: date, last_reviewed_at: "旧日期", sort_date: date });
const cursor = (id: number) => Buffer.from(JSON.stringify({ updatedAt: date, id })).toString("base64url");
const page = (id: number, nextCursor: string | null = null) => ({ items: [card(id)], nextCursor, summary: { date, total: 3, due: 3, notebook: 3, remedial: 0, overdue: 0, completed_today: 0 } });

describe("复习列表整页校验与查询隔离", () => {
  it("串来源的成功首页不能显示为当前筛选", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ ...page(1), items: [{ ...card(1), source: "remedial" }] });
    const hook = renderHook(() => useReviewList({ scope: "due", source: "notebook", limit: 1 }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.data).toBeNull(); expect(hook.result.current.error).not.toBe("");
  });

  it("切换筛选后新首页失败，不能把旧来源题目与统计挂在新筛选下", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(page(1)).mockRejectedValueOnce(new Error("新来源读取失败"));
    const hook = renderHook(({ source }: { source: "notebook" | "remedial" }) => useReviewList({ scope: "due", source, limit: 1 }), { initialProps: { source: "notebook" } });
    await waitFor(() => expect(hook.result.current.data?.items).toHaveLength(1)); hook.rerender({ source: "remedial" });
    await waitFor(() => expect(hook.result.current.error).toBe("新来源读取失败")); expect(hook.result.current.data).toBeNull();
  });

  it("重复边界不能靠去重伪装成末页，修复后仍用原游标重读", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(page(1, cursor(1))).mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(2));
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 1 }));
    await waitFor(() => expect(hook.result.current.data?.nextCursor).toBe(cursor(1)));
    await act(() => hook.result.current.loadMore()); expect(hook.result.current.error).not.toBe("");
    expect(hook.result.current.data?.nextCursor).toBe(cursor(1)); expect(hook.result.current.data?.items.map(item => item.id)).toEqual([1]);
    await act(() => hook.result.current.loadMore()); expect(hook.result.current.data?.items.map(item => item.id)).toEqual([1, 2]);
    expect(vi.mocked(jsonFetch).mock.calls.slice(1).map(([url]) => new URL(url, "http://localhost").searchParams.get("cursor"))).toEqual([cursor(1), cursor(1)]);
  });

  it("坏尾游标整页拒绝，不对用户展示无法继续读取的页", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(page(1, cursor(2)));
    const hook = renderHook(() => useReviewList({ scope: "due", source: "all", limit: 1 }));
    await waitFor(() => expect(hook.result.current.loading).toBe(false)); expect(hook.result.current.data).toBeNull(); expect(hook.result.current.error).not.toBe("");
  });
});
