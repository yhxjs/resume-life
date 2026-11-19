// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewHistory } from "../review-history";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const attempt = { id: 20, answer: "完整旧历史 <T> &amp;\n内部  空格", grade: "good" as const, reviewed_at: "2026-10-29T00:00:00Z", interval_days: 1, next_review_date: "2026-10-30" };
const page = { id: 301, source: "notebook", source_id: 91, source_label: "来源", question: "原题", answer: "", reference: "", comment: "", mastery: "learning", interval_days: 1, ease_factor: 250, repetitions: 1, review_count: 25, lapses: 0, next_review_date: "旧日期", last_reviewed_at: "旧日期", attempts: [{ ...attempt, id: 19, answer: "真正下一页" }], nextCursor: null };

describe("复习历史整页边界与原游标恢复", () => {
  it.each([{ ...page, id: 302 }, { ...page, attempts: [{ ...attempt, answer: "重复边界" }] }, { ...page, attempts: [page.attempts[0], page.attempts[0]] }, { ...page, nextCursor: "18" }, { ...page, attempts: null }])("坏页 %j 保留已有全文与原游标，修复后只追加真实下一页", async bad => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(bad).mockResolvedValueOnce(page); render(<ReviewHistory cardId={301} initialAttempts={[attempt]} initialCursor="20" />);
    fireEvent.click(screen.getByRole("button", { name: "加载更多历史" })); await screen.findByRole("alert"); expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "重试加载历史" })); await screen.findByText("真正下一页"); expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(vi.mocked(jsonFetch).mock.calls.map(([url]) => new URL(url, "http://localhost").searchParams.get("cursor"))).toEqual(["20", "20"]);
    expect(vi.mocked(jsonFetch).mock.calls.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });
  it("同事件只读取一次，离页取消且迟到坏页不追加", async () => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise); const view = render(<ReviewHistory cardId={301} initialAttempts={[attempt]} initialCursor="20" />);
    const button = screen.getByRole("button", { name: "加载更多历史" }); act(() => { fireEvent.click(button); fireEvent.click(button); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce()); const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!; view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve({}); });
  });
});
