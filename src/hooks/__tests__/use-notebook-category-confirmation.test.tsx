// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { CategoryManageDialog } from "@/components/notebook";
import { jsonFetch } from "@/lib/fetcher";
import { useNotebookCategoryCommand } from "../use-notebook-category-command";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const input = { kind: "delete", id: 7, name: "原分类 <T> &amp;", entryCount: 2 } as const;
beforeEach(() => {
  vi.mocked(jsonFetch).mockResolvedValue({ ok: true });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("分类删除与真实确认队列的归属", () => {
  it("离页关闭当前确认并结算等待，保留的旧入口不再发起操作", async () => {
    render(<ConfirmDialogHost />);
    const completed = vi.fn(); const locked = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed, locked));
    const methods = hook.result.current; const settled = vi.fn();
    act(() => { void methods.run(input).then(settled); });
    expect(screen.getByRole("dialog").textContent).toContain(input.name);
    hook.unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await act(async () => { await methods.run(input); methods.reread(); });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
    expect(locked).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("离页移除排队分类确认，保留其他当前项和有效队列项", async () => {
    render(<ConfirmDialogHost />);
    act(() => { void confirmDialog({ title: "其他确认", message: "先处理此项" }); });
    const completed = vi.fn(); const old = renderHook(() => useNotebookCategoryCommand(completed));
    const settled = vi.fn(); act(() => { void old.result.current.run(input).then(settled); });
    const next = renderHook(() => useNotebookCategoryCommand(completed));
    act(() => { void next.result.current.run({ ...input, id: 8, name: "有效分类" }); });
    old.unmount();
    expect(screen.getByRole("dialog").textContent).toContain("其他确认");
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    const dialog = screen.getByRole("dialog", { name: "删除分类" });
    expect(dialog.textContent).toContain("有效分类"); expect(dialog.textContent).not.toContain(input.name);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(next.result.current.canStart()).toBe(true));
    expect(jsonFetch).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
  });

  it("撤销当前项后另一实例仍须独立确认，旧项不写入或回调", async () => {
    render(<ConfirmDialogHost />);
    const oldCompleted = vi.fn(); const completed = vi.fn();
    const old = renderHook(() => useNotebookCategoryCommand(oldCompleted));
    const next = renderHook(() => useNotebookCategoryCommand(completed));
    act(() => { void old.result.current.run(input); void next.result.current.run({ ...input, id: 8, name: "下一分类" }); });
    old.unmount();
    const dialog = screen.getByRole("dialog", { name: "删除分类" });
    expect(dialog.textContent).toContain("下一分类"); expect(jsonFetch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(oldCompleted).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenCalledExactlyOnceWith("/api/notebook/categories/8", expect.objectContaining({ method: "DELETE" }));
  });

  it("确认接受后同事件离页，尚未发出的删除不继续", async () => {
    render(<ConfirmDialogHost />);
    const completed = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed));
    const settled = vi.fn(); act(() => { void hook.result.current.run(input).then(settled); });
    act(() => { screen.getByRole("button", { name: "删除" }).click(); hook.unmount(); });
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(jsonFetch).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
  });

  it.each(["取消", "Escape"])("管理弹窗%s后归还删除按钮焦点；同事件重复点击仍只确认和删除一次", async cancel => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => (init?.method ? { ok: true } : [{ id: 7, name: input.name, entry_count: 2 }]) as never);
    const completed = vi.fn(); const close = vi.fn();
    render(<><CategoryManageDialog onClose={close} onChanged={completed} /><ConfirmDialogHost /></>);
    const manage = screen.getByRole("dialog", { name: "管理分类" }); await within(manage).findByText(input.name);
    const remove = within(manage).getByRole("button", { name: "删除" }); remove.focus();
    act(() => { remove.click(); remove.click(); });
    const dialog = screen.getByRole("dialog", { name: "删除分类" });
    expect((within(manage).getByRole("button", { name: "新建" }) as HTMLButtonElement).disabled).toBe(true);
    if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(remove));
    expect(screen.queryByRole("dialog", { name: "删除分类" })).toBeNull(); expect(close).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    act(() => { remove.click(); remove.click(); });
    fireEvent.click(within(screen.getByRole("dialog", { name: "删除分类" })).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "删除分类" })).toBeNull();
  });
});
