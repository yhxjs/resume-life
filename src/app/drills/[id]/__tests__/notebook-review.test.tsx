// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { NotebookStarButton } from "@/components/notebook";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "1" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const review = { review_card_id: 301, review_mastery: "new", next_review_date: "2026-10-28" };
function drillData(favorited = false) {
  return {
    id: 1, source: "bank", direction: "接口工程师", jd: "", project_id: null,
    questions: [{ id: 11, idx: 1, question: "如何核对个人分工？", answer: "只参与接口校验，尚未上线。",
      comment: "仅评价原答", reference: "按事实表达", scores: null, answered_at: "2026-10-28", kind: "tech",
      notebook_id: favorited ? 99 : null, review_card_id: favorited ? review.review_card_id : null,
      review_mastery: favorited ? review.review_mastery : null, next_review_date: favorited ? review.next_review_date : null }],
  };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("收藏与复习入口同步", () => {
  it("收藏已答普通练习立即出现复习入口，取消后立即移除，不必刷新", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url, options) => {
      if (url === "/api/drills/1") return drillData() as never;
      if (url === "/api/notebook/categories") return [] as never;
      if (url === "/api/notebook" && options?.method === "POST") return { id: 99, review } as never;
      if (url === "/api/notebook/lookup?source=drill&source_id=11") return { id: 99, source: "drill", source_id: 11, category_id: null, question: "如何核对个人分工？", answer: "只参与接口校验，尚未上线。", comment: "仅评价原答", reference: "按事实表达", review } as never;
      if (url === "/api/notebook/99" && options?.method === "DELETE") return { ok: true } as never;
      throw new Error(`Unexpected request ${url}`);
    });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "收藏到错题本" }));
    const dialog = screen.getByRole("dialog", { name: "收藏到错题本" });
    fireEvent.click(within(dialog).getByRole("button", { name: "收藏" }));
    expect((await screen.findByRole("link", { name: "开始间隔复习" })).getAttribute("href")).toBe("/reviews?card=301");
    expect(screen.getByText(/未复习/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消收藏" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "开始间隔复习" })).toBeNull());
    expect(screen.getByRole("button", { name: "收藏到错题本" })).toBeTruthy();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/drills/1")).toHaveLength(1);
  });

  for (const initiallyFavorited of [false, true]) {
    it(`评分回读等待期间${initiallyFavorited ? "取消收藏" : "新收藏"}，旧回读不能恢复过期关联`, async () => {
      const pendingRead = deferred<unknown>();
      let reads = 0;
      vi.mocked(jsonFetch).mockImplementation(async (url, options) => {
        if (url === "/api/drills/1") return (reads++ === 0 ? drillData(initiallyFavorited) : pendingRead.promise) as never;
        if (url === "/api/drills/1/questions/11") return {} as never;
        if (url === "/api/notebook/categories") return [] as never;
        if (url === "/api/notebook" && options?.method === "POST") return { id: 99, review } as never;
        if (url === "/api/notebook/lookup?source=drill&source_id=11") return { id: 99, source: "drill", source_id: 11, category_id: null, question: "如何核对个人分工？", answer: "只参与接口校验，尚未上线。", comment: "仅评价原答", reference: "按事实表达", review } as never;
        if (url === "/api/notebook/99" && options?.method === "DELETE") return { ok: true } as never;
        throw new Error(`Unexpected request ${url}`);
      });
      render(<Page />);
      fireEvent.click(await screen.findByRole("button", { name: "重答本题 ↺" }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "新提交原答" } });
      fireEvent.click(screen.getByRole("button", { name: "保存并重新打分" }));
      await waitFor(() => expect(reads).toBe(2));
      if (initiallyFavorited) {
        fireEvent.click(screen.getByRole("button", { name: "取消收藏" }));
        await screen.findByRole("button", { name: "收藏到错题本" });
      } else {
        fireEvent.click(screen.getByRole("button", { name: "收藏到错题本" }));
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "收藏" }));
        await screen.findByRole("button", { name: "取消收藏" });
      }
      const stale = drillData(initiallyFavorited);
      stale.questions[0]!.answer = "新提交原答";
      stale.questions[0]!.comment = "新评分点评";
      await act(async () => { pendingRead.resolve(stale); });
      expect(screen.getByText("新评分点评", { exact: true })).toBeTruthy();
      expect(screen.getByRole("button", { name: initiallyFavorited ? "收藏到错题本" : "取消收藏" })).toBeTruthy();
      if (initiallyFavorited) expect(screen.queryByRole("link", { name: "开始间隔复习" })).toBeNull();
      else expect(screen.getByRole("link", { name: "开始间隔复习" }).getAttribute("href")).toBe("/reviews?card=301");
    });
  }

  it("取消收藏连点只确认一次，明确拒绝就近显示并可再次确认", async () => {
    const pending = deferred<unknown>();
    const changed = vi.fn();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: true });
    render(<NotebookStarButton source="drill" sourceId={11} question="原题" notebookId={99} onChanged={changed} />);
    const button = screen.getByRole("button", { name: "取消收藏" });
    act(() => { button.click(); button.click(); });
    expect(confirmDialog).toHaveBeenCalledOnce();
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending.reject(new HttpError("取消失败，请稍后重试", 409)); });
    expect((await screen.findByRole("alert")).textContent).toContain("取消失败，请稍后重试");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(changed).toHaveBeenCalledWith(null, null));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("切换题目清除原题弹窗与分类，晚到收藏不会关闭新题弹窗或冒用新题回调", async () => {
    const pending = deferred<unknown>();
    const firstChanged = vi.fn();
    const secondChanged = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (url) => {
      if (url === "/api/notebook/categories") return [{ id: 7, name: "原题分类", entry_count: 0 }] as never;
      if (url === "/api/notebook") return pending.promise as never;
      throw new Error(`Unexpected request ${url}`);
    });
    const { rerender } = render(<NotebookStarButton source="drill" sourceId={11} question="原题" notebookId={null} onChanged={firstChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "收藏到错题本" }));
    fireEvent.click(await screen.findByRole("button", { name: "原题分类" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "收藏" }));
    rerender(<NotebookStarButton source="drill" sourceId={12} question="新题" notebookId={null} onChanged={secondChanged} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收藏到错题本" }));
    const newDialog = screen.getByRole("dialog");
    expect(within(newDialog).getByText("新题")).toBeTruthy();
    await act(async () => { pending.resolve({ id: 99, review }); });
    expect(screen.getByRole("dialog")).toBe(newDialog);
    expect(firstChanged).not.toHaveBeenCalled();
    expect(secondChanged).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls.find(([, options]) => options?.method === "POST")?.[1]?.body))).toEqual({ source: "drill", source_id: 11, category_id: 7 });
  });
});
