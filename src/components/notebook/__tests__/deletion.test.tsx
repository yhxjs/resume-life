// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookStarButton } from "../index";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const props = { source: "drill" as const, sourceId: 11, question: "完整原题 <T> &amp;\n内部  空格", notebookId: 7, onChanged: vi.fn() };
const snapshot = { id: 7, question: props.question, answer: "原答", comment: "旧点评", reference: "旧参考" };

describe("取消收藏使用错题删除恢复", () => {
  it("取消确认不删除、不更新复习入口，显示唯一副本风险", async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false); render(<NotebookStarButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "取消收藏" })); await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());
    expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain("可能是唯一副本"); expect(jsonFetch).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "取消收藏" })).toBeTruthy();
  });

  it("坏删除回包且仍存在时保留收藏，再确认才执行下一次删除", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ok: true }); render(<NotebookStarButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "取消收藏" })); await screen.findByText(/错题 #7 目前仍存在/);
    expect(props.onChanged).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "取消收藏" })); await waitFor(() => expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(null, null));
    expect(confirmDialog).toHaveBeenCalledTimes(2); expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it("未知结果只允许重读，404 后才清空本地复习关联并通知今日队列", async () => {
    const pending = Promise.withResolvers<unknown>(); const updated = vi.fn(); window.addEventListener("reviews-updated", updated);
    try {
      vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("读取失败", 503)).mockReturnValueOnce(pending.promise); render(<NotebookStarButton {...props} />);
      const star = screen.getByRole("button", { name: "取消收藏" }); act(() => { star.click(); star.click(); });
      const retry = await screen.findByRole("button", { name: "重新读取删除状态" }); expect((star as HTMLButtonElement).disabled).toBe(true);
      expect(props.onChanged).not.toHaveBeenCalled(); expect(updated).not.toHaveBeenCalled();
      act(() => { retry.click(); retry.click(); star.click(); }); expect(jsonFetch).toHaveBeenCalledTimes(3);
      await act(async () => { pending.reject(new HttpError("不存在", 404)); });
      expect(props.onChanged).toHaveBeenCalledExactlyOnceWith(null, null); expect(updated).toHaveBeenCalledOnce(); expect(screen.getByRole("button", { name: "收藏到错题本" })).toBeTruthy();
    } finally { window.removeEventListener("reviews-updated", updated); }
  });

  it.each(["confirm", "delete", "check"])("同一道题更换收藏 ID 时终止旧 %s，迟到结果不能清除新收藏", async phase => {
    const pending = Promise.withResolvers<unknown>();
    if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise as Promise<boolean>);
    if (phase === "delete") vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    if (phase === "check") vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockReturnValueOnce(pending.promise);
    const nextChanged = vi.fn(); const { rerender } = render(<NotebookStarButton {...props} />); fireEvent.click(screen.getByRole("button", { name: "取消收藏" }));
    if (phase !== "confirm") await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "check" ? 2 : 1));
    const signal = vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal;
    rerender(<NotebookStarButton {...props} notebookId={8} onChanged={nextChanged} />); if (signal) expect(signal.aborted).toBe(true);
    await act(async () => { if (phase === "confirm") pending.resolve(true); else pending.reject(new HttpError("不存在", 404)); });
    expect(props.onChanged).not.toHaveBeenCalled(); expect(nextChanged).not.toHaveBeenCalled(); expect((screen.getByRole("button", { name: "取消收藏" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
