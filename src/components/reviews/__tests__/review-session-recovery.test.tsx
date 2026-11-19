// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewSession } from "../review-session";
import { jsonFetch } from "@/lib/fetcher";
import type { ReviewDetail } from "@/lib/spaced-repetition-card-types";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const detail: ReviewDetail = {
  id: 301, source: "notebook", source_id: 91, source_label: "原收藏", question: "完整原题 <T> &amp;\n内部  空格",
  answer: "历史原答", reference: "完整参考", comment: "原点评", mastery: "learning", interval_days: 1,
  ease_factor: 250, repetitions: 1, review_count: 1, lapses: 0, next_review_date: "2026-10-29", last_reviewed_at: "旧日期",
  attempts: [], nextCursor: null,
};
async function prepared(onSaved = vi.fn()) {
  render(<ReviewSession cardId={301} onSaved={onSaved} onClose={vi.fn()} />);
  await screen.findByRole("heading", { name: /完整原题/ });
  fireEvent.change(screen.getByRole("textbox", { name: "本次回答" }), { target: { value: "  独立回忆 <T> &amp;\n内部  空格  " } });
  fireEvent.click(screen.getByRole("button", { name: "查看参考并自评" }));
  fireEvent.click(screen.getByRole("button", { name: /基本掌握/ }));
  return onSaved;
}

describe("复习详情与保存结果的真实确认", () => {
  it("串题详情不能展示成当前卡片，也不能开放作答", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ ...detail, id: 302, question: "别的卡片原题" });
    render(<ReviewSession cardId={301} onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
    expect(screen.queryByText("别的卡片原题")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("坏成功回包不通知父级，核对失败时保留原稿和提交锁", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail).mockResolvedValueOnce({
      card: { ...detail, id: 999, review_count: 2 },
      attempt: { id: 6, answer: "其他回答", grade: "easy", reviewed_at: "旧日期", interval_days: 1, next_review_date: "旧日期" },
    }).mockRejectedValue(new Error("只读核对失败"));
    const onSaved = await prepared();
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByText("本次复习已保存")).toBeNull();
    expect((screen.getByRole("textbox", { name: "本次回答" }) as HTMLTextAreaElement).value).toBe("  独立回忆 <T> &amp;\n内部  空格  ");
    expect((screen.getByRole("textbox", { name: "本次回答" }) as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("网络失败后先只读核对，不能改稿换编号重复提交", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail).mockRejectedValue(new Error("网络故障"));
    const onSaved = await prepared();
    fireEvent.click(screen.getByRole("button", { name: "保存本次复习" }));
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox", { name: "本次回答" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "重新读取保存状态" })).toBeTruthy();
  });

  it.each(["posting", "checking"])("切换卡片时取消旧 %s，迟到结果不污染新原题、空白回答或回调", async phase => {
    const pending = Promise.withResolvers<unknown>(); const oldSaved = vi.fn(); const newSaved = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (url.startsWith("/api/reviews/302?")) return { ...detail, id: 302, source_id: 92, question: "新卡原题" };
      if (init?.method === "POST") return phase === "posting" ? pending.promise : {};
      if (url.includes("/requests/")) return pending.promise;
      return detail;
    });
    const view = render(<ReviewSession cardId={301} onSaved={oldSaved} onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: /完整原题/ }); fireEvent.change(screen.getByRole("textbox", { name: "本次回答" }), { target: { value: "旧卡的独立回忆" } });
    fireEvent.click(screen.getByRole("button", { name: "查看参考并自评" })); fireEvent.click(screen.getByRole("button", { name: /基本掌握/ })); fireEvent.click(screen.getByRole("button", { name: "保存本次复习" }));
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.some(([url, init]) => phase === "posting" ? init?.method === "POST" : url.includes("/requests/"))).toBe(true));
    const call = vi.mocked(jsonFetch).mock.calls.find(([url, init]) => phase === "posting" ? init?.method === "POST" : url.includes("/requests/"))!;
    view.rerender(<ReviewSession cardId={302} onSaved={newSaved} onClose={vi.fn()} />); await screen.findByRole("heading", { name: "新卡原题" }); expect(call[1]!.signal!.aborted).toBe(true);
    await act(async () => { pending.resolve({}); }); expect(oldSaved).not.toHaveBeenCalled(); expect(newSaved).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "本次回答" }) as HTMLTextAreaElement).value).toBe(""); expect(screen.queryByText("本次复习已保存")).toBeNull();
    expect(screen.queryByText("完整参考")).toBeNull(); expect(screen.getByRole("button", { name: "查看参考并自评" })).toBeTruthy();
  });
});
