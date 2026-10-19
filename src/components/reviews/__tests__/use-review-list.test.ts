import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewList } from "../use-review-list";
import { jsonFetch } from "@/lib/fetcher";
import type { ReviewCard, ReviewList } from "@/lib/spaced-repetition-card-types";

let slots: unknown[] = [];
let cursor = 0;
let search: { load: (signal: AbortSignal) => Promise<ReviewList>; onStart: () => void; onSuccess: (page: ReviewList) => void; onError: (error: Error) => void } | undefined;
let effects: Array<() => unknown> = [];
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(slots[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => unknown) => { effects.push(effect); },
}));
vi.mock("@/hooks/use-debounced-search", () => ({ useDebouncedSearch: (options: typeof search) => { search = options; } }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const first: ReviewList = { items: [], nextCursor: "page-2", summary: { date: "2026-09-27", due: 1, total: 2, notebook: 1, remedial: 0, overdue: 0, completed_today: 0 } };
function ReviewListHarness({ source }: { source: "all" | "notebook" }) { return useReviewList({ scope: "due", source, limit: 3 }); }
function render(source: "all" | "notebook" = "all") { cursor = 0; return ReviewListHarness({ source }); }

beforeEach(() => { slots = []; cursor = 0; search = undefined; effects = []; vi.clearAllMocks(); });

describe("复习列表请求", () => {
  it("默认今日请求带浏览器时区和分页上限", async () => {
    render(); expect(search).toBeDefined();
    vi.mocked(jsonFetch).mockResolvedValue(first);
    search!.onStart(); const page = await search!.load(new AbortController().signal); search!.onSuccess(page);
    const url = new URL(String(vi.mocked(jsonFetch).mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.get("scope")).toBe("due"); expect(url.searchParams.get("source")).toBe("all"); expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("time_zone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(render().data).toEqual(first);
  });

  it("分页失败保留题目与游标，可从同一页重试", async () => {
    render(); expect(search).toBeDefined(); search!.onStart(); search!.onSuccess(first);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("翻页失败"));
    await render().loadMore();
    expect(render().data).toEqual(first); expect(render().error).toBe("翻页失败");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...first, nextCursor: null });
    await render().loadMore();
    expect(render().data?.nextCursor).toBeNull(); expect(render().error).toBe("");
    expect(vi.mocked(jsonFetch).mock.calls.every(([url]) => String(url).includes("cursor=page-2"))).toBe(true);
  });

  it("更换来源后旧分页响应不能覆盖新筛选数据", async () => {
    render(); expect(search).toBeDefined(); search!.onStart(); search!.onSuccess(first);
    let resolve!: (page: ReviewList) => void;
    vi.mocked(jsonFetch).mockReturnValue(new Promise<ReviewList>((done) => { resolve = done; }));
    const pending = render().loadMore();
    render("notebook"); search!.onStart(); const fresh = { ...first, nextCursor: null, summary: { ...first.summary, total: 1 } }; search!.onSuccess(fresh);
    resolve({ ...first, nextCursor: "stale" }); await pending;
    expect(render("notebook").data).toEqual(fresh);
  });

  it("刷新保留已加载页数，更换来源后从第一页重新加载", async () => {
    const card = (id: number): ReviewCard => ({ id, source: "notebook", source_id: id, source_label: "错题", question: `题目 ${id}`, mastery: "new", interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: "2026-09-27", last_reviewed_at: "" });
    const pageOne: ReviewList = { ...first, items: [card(1), card(2), card(3)] };
    const pageTwo: ReviewList = { ...first, items: [card(4)], nextCursor: null };
    render(); search!.onStart(); search!.onSuccess(pageOne);
    vi.mocked(jsonFetch).mockResolvedValueOnce(pageTwo);
    await render().loadMore();
    expect(render().data?.items).toHaveLength(4);
    vi.mocked(jsonFetch).mockClear().mockResolvedValueOnce(pageOne).mockResolvedValueOnce(pageTwo);
    render().reload(); render(); search!.onStart();
    search!.onSuccess(await search!.load(new AbortController().signal));
    expect(render().data?.items.map(item => item.id)).toEqual([1, 2, 3, 4]);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    const moved = { ...card(1), review_count: 1, next_review_date: "2026-09-28" };
    vi.mocked(jsonFetch).mockClear().mockResolvedValueOnce(pageOne).mockResolvedValueOnce({ ...pageTwo, items: [card(4), moved] });
    render().reload(); render(); search!.onStart();
    search!.onSuccess(await search!.load(new AbortController().signal));
    expect(render().data?.items.map(item => item.id)).toEqual([1, 2, 3, 4]);
    expect(render().data?.items[0]?.review_count).toBe(1);
    vi.mocked(jsonFetch).mockClear().mockResolvedValueOnce(pageOne);
    render("notebook"); search!.onStart();
    search!.onSuccess(await search!.load(new AbortController().signal));
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect(render("notebook").data?.items).toHaveLength(3);
  });
});
