// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import Page from "@/app/bank/page";
import { jsonFetch } from "@/lib/fetcher";
import { useBankImport } from "../use-bank-import";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const draft = { direction: "后端 <T> &amp;", kind: "behavior" as const, text: "第一题 内部  空格\n第二题 <T> &amp;" };
const page = { items: [], nextCursor: null };
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => (init?.method === "POST" ? null : url === "/api/bank/directions" ? [] : page) as never);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });
async function setup(refresh = vi.fn()) {
  const hook = renderHook(() => useBankImport(refresh));
  act(() => hook.result.current.change(draft));
  await act(() => hook.result.current.submit());
  expect(hook.result.current.phase).toBe("unknown");
  return hook;
}

describe("题库再次导入确认的真实队列归属", () => {
  it("离页关闭当前确认并结算等待，旧入口不能再次确认或读写", async () => {
    render(<ConfirmDialogHost />); const refresh = vi.fn(); const old = await setup(refresh);
    const methods = old.result.current; const settled = vi.fn();
    act(() => { void methods.allowRetry().then(settled); });
    expect(screen.getByRole("dialog").textContent).toContain(draft.direction);
    const requests = vi.mocked(jsonFetch).mock.calls.length; refresh.mockClear();
    old.unmount(); expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    await act(async () => { await methods.allowRetry(); await methods.submit(); methods.reread(); methods.change({ text: "迟到改稿" }); });
    expect(jsonFetch).toHaveBeenCalledTimes(requests); expect(refresh).not.toHaveBeenCalled();
  });

  it("离页移除排队确认并结算，不影响其他当前确认和有效后续项", async () => {
    render(<ConfirmDialogHost />); act(() => { void confirmDialog({ title: "其他确认", message: "先处理此项" }); });
    const old = await setup(); const settled = vi.fn();
    act(() => { void old.result.current.allowRetry().then(settled); });
    act(() => { void confirmDialog({ title: "有效确认", message: "继续处理此项" }); });
    old.unmount(); expect(screen.getByRole("dialog").textContent).toContain("其他确认");
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("dialog").textContent).toContain("有效确认");
    fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(posts()).toHaveLength(1);
  });

  it("旧当前确认撤销后，新实例仍独立锁定原稿，确认仅解锁、不自动导入", async () => {
    render(<ConfirmDialogHost />); const old = await setup();
    act(() => { void old.result.current.allowRetry(); });
    const next = await setup(); act(() => { void next.result.current.allowRetry(); });
    old.unmount(); expect(next.result.current.phase).toBe("confirming");
    const dialog = screen.getByRole("dialog", { name: "允许再次导入" });
    fireEvent.click(within(dialog).getByRole("button", { name: "允许再次导入" }));
    await waitFor(() => expect(next.result.current.canStart()).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(next.result.current.draft).toEqual(draft); expect(posts()).toHaveLength(2);
  });

  it("确认接受后同事件离页，不释放新实例正在提交的命令", async () => {
    render(<ConfirmDialogHost />); const old = await setup(); const settled = vi.fn();
    act(() => { void old.result.current.allowRetry().then(settled); });
    act(() => { screen.getByRole("button", { name: "允许再次导入" }).click(); old.unmount(); });
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const refresh = vi.fn(); const next = renderHook(() => useBankImport(refresh));
    act(() => { next.result.current.change({ ...draft, text: "新页原题" }); void next.result.current.submit(); });
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(next.result.current.phase).toBe("submitting"); expect(next.result.current.draft.text).toBe("新页原题"); expect(refresh).not.toHaveBeenCalled();
    await act(async () => { pending.resolve({ count: 1 }); }); expect(refresh).toHaveBeenCalledOnce();
  });

  it.each(["取消", "Escape"])("页面%s后焦点回到允许按钮，原稿及快照保留，重复点击仍单次确认", async cancel => {
    render(<><Page /><ConfirmDialogHost /></>);
    const input = screen.getByRole("textbox", { name: "导入考题" }); fireEvent.change(input, { target: { value: draft.text } });
    fireEvent.click(screen.getByRole("button", { name: "导入 2 道考题" }));
    const allow = await screen.findByRole("button", { name: "保留原稿并允许再次导入" }); allow.focus();
    act(() => { allow.click(); allow.click(); });
    const dialog = screen.getByRole("dialog", { name: "允许再次导入" }); expect(dialog.textContent).toContain("可能产生重复");
    if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(allow));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(input.matches(":disabled")).toBe(true); expect((input as HTMLTextAreaElement).value).toBe(draft.text);
    expect(screen.getByRole("region", { name: "导入结果核对快照" })).toBeTruthy(); expect(posts()).toHaveLength(1);
    act(() => { allow.click(); allow.click(); });
    fireEvent.click(within(screen.getByRole("dialog", { name: "允许再次导入" })).getByRole("button", { name: "允许再次导入" }));
    await waitFor(() => expect(input.matches(":disabled")).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(posts()).toHaveLength(1); expect((input as HTMLTextAreaElement).value).toBe(draft.text);
  });
});
