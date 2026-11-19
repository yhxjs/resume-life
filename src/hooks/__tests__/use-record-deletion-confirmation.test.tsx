// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { useRecordDeletion, type DeletionPolicy } from "../use-record-deletion";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
beforeEach(() => { vi.mocked(jsonFetch).mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const policy = (title: string): DeletionPolicy => ({
  baseUrl: "/api/bank", confirmTitle: title, confirmMessage: (id, text) => `删除 #${id}「${text}」？`,
  validateExisting: () => {}, recordLabel: "题目", listLabel: "题库",
});

describe("删除操作与真实全局确认队列的归属", () => {
  it("离页关闭当前确认并结算等待，重开后取消不写入", async () => {
    render(<ConfirmDialogHost />);
    const refresh = vi.fn(); const old = renderHook(() => useRecordDeletion(policy("旧页面删除"), refresh));
    const settled = vi.fn(); const methods = old.result.current;
    act(() => { void methods.remove(7, "旧原题").then(settled); });
    expect(screen.getByRole("dialog").textContent).toContain("旧原题");
    old.unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    const next = renderHook(() => useRecordDeletion(policy("新页面删除"), refresh));
    act(() => { void next.result.current.remove(8, "新原题"); });
    const dialog = screen.getByRole("dialog", { name: "新页面删除" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(next.result.current.canStart()).toBe(true));
    await act(async () => { await methods.remove(7, "迟到入口"); methods.retryCheck(); });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });

  it("离页移除排队删除，不关闭当前确认或阻塞下一项", async () => {
    render(<ConfirmDialogHost />);
    act(() => { void confirmDialog({ title: "其他操作", message: "先处理此项" }); });
    const refresh = vi.fn(); const old = renderHook(() => useRecordDeletion(policy("已过期删除"), refresh));
    const settled = vi.fn();
    act(() => { void old.result.current.remove(7, "排队原题").then(settled); });
    const next = renderHook(() => useRecordDeletion(policy("有效删除"), refresh));
    act(() => { void next.result.current.remove(8, "有效原题"); });
    old.unmount();
    expect(screen.getByRole("dialog").textContent).toContain("其他操作");
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    const dialog = screen.getByRole("dialog", { name: "有效删除" });
    expect(dialog.textContent).not.toContain("排队原题");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(next.result.current.canStart()).toBe(true));
    expect(jsonFetch).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });

  it("离页只撤销本项，另一实例仍须独立确认才删除", async () => {
    render(<ConfirmDialogHost />);
    const oldRefresh = vi.fn(); const newRefresh = vi.fn();
    const old = renderHook(() => useRecordDeletion(policy("旧删除"), oldRefresh));
    const next = renderHook(() => useRecordDeletion(policy("新删除"), newRefresh));
    act(() => { void old.result.current.remove(7, "旧题"); void next.result.current.remove(8, "新题"); });
    old.unmount();
    const dialog = screen.getByRole("dialog", { name: "新删除" });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(next.result.current.canStart()).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(newRefresh).toHaveBeenCalledOnce());
    expect(oldRefresh).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenCalledExactlyOnceWith("/api/bank/8", expect.objectContaining({ method: "DELETE" }));
    expect(next.result.current.deletedIds.has(8)).toBe(true); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("正常取消释放同步锁，随后重新确认仍只删除一次", async () => {
    render(<ConfirmDialogHost />);
    const refresh = vi.fn(); const hook = renderHook(() => useRecordDeletion(policy("正常删除"), refresh));
    act(() => { void hook.result.current.remove(7, "原题"); void hook.result.current.remove(8, "另一题"); });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(hook.result.current.canStart()).toBe(true));
    expect(jsonFetch).not.toHaveBeenCalled();
    act(() => { void hook.result.current.remove(8, "另一题"); });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(jsonFetch).toHaveBeenCalledExactlyOnceWith("/api/bank/8", expect.objectContaining({ method: "DELETE" }));
  });
});
