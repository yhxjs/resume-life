// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { LocalDataCleanup } from "../local-data-cleanup";

const draftKey = "resume-life:draft:synthetic";
const draft = '{"title":"原稿 <T> &amp; 内部  空格"}';
const button = () => screen.getByRole("button", { name: "清除本机敏感副本" });
const dialog = () => screen.getByRole("dialog", { name: "清除本机敏感副本" });
const accept = () => fireEvent.click(within(dialog()).getByRole("button", { name: "清除副本" }));
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); sessionStorage.setItem(draftKey, draft); localStorage.setItem("resume_life_anonymize_config", "原脱敏配置");
  localStorage.setItem("resume_life_project_repo_paths_old:7", '["C:/原源码路径"]'); sessionStorage.setItem("unrelated", "保留"); localStorage.setItem("unrelated", "保留");
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });

describe("本机副本清理确认的归属", () => {
  it("离页关闭当前确认且保留敏感副本，新实例可以重新取消", async () => {
    render(<ConfirmDialogHost />); const old = render(<LocalDataCleanup />); fireEvent.click(button()); old.unmount(); expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(draftKey)).toBe(draft);
    render(<LocalDataCleanup />); fireEvent.click(button()); fireEvent.keyDown(document, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(sessionStorage.getItem(draftKey)).toBe(draft);
  });
  it("离页移除排队清理确认，其他当前及后续确认不受影响", () => {
    render(<ConfirmDialogHost />); const old = render(<LocalDataCleanup />); act(() => { void confirmDialog({ title: "当前有效", message: "其他工作" }); }); fireEvent.click(button());
    act(() => { void confirmDialog({ title: "后续有效", message: "后续工作" }); }); old.unmount(); fireEvent.click(screen.getByRole("button", { name: "确定" })); expect(screen.getByRole("dialog").textContent).toContain("后续有效"); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(sessionStorage.getItem(draftKey)).toBe(draft);
  });
  it.each(["取消", "Escape"])("重复点击只显示本次确认，%s归还焦点且原稿逐字保留", async cancel => {
    render(<><LocalDataCleanup /><ConfirmDialogHost /></>); const trigger = button(); trigger.focus(); act(() => { trigger.click(); trigger.click(); });
    if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" }); else fireEvent.click(within(dialog()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger)); expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(draftKey)).toBe(draft); expect(localStorage.getItem("resume_life_anonymize_config")).toBe("原脱敏配置");
  });
  it("接受后同事件离页不清理，新实例未保存的最新草稿继续保留", async () => {
    const old = render(<><LocalDataCleanup /><ConfirmDialogHost /></>); fireEvent.click(button()); act(() => { accept(); old.unmount(); }); sessionStorage.setItem(draftKey, "新实例原稿");
    render(<><LocalDataCleanup /><ConfirmDialogHost /></>); await act(async () => {}); expect(sessionStorage.getItem(draftKey)).toBe("新实例原稿"); expect(screen.queryByRole("status")).toBeNull();
  });
  it("保留的旧入口卸载后不能再排确认或清理", () => {
    render(<ConfirmDialogHost />); const old = render(<LocalDataCleanup />); const trigger = button(); old.unmount(); fireEvent.click(trigger); expect(screen.queryByRole("dialog")).toBeNull(); expect(sessionStorage.getItem(draftKey)).toBe(draft);
  });
  it("只清声明的敏感键，错误不报成功，恢复存储后重新明确确认才能完成", async () => {
    render(<><LocalDataCleanup /><ConfirmDialogHost /></>); const failure = vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => { throw new Error("存储拒绝"); });
    fireEvent.click(button()); accept(); await screen.findByRole("alert"); expect(screen.queryByRole("status")).toBeNull(); expect(sessionStorage.getItem(draftKey)).toBe(draft); failure.mockRestore();
    fireEvent.click(button()); accept(); await screen.findByRole("status"); expect(sessionStorage.getItem(draftKey)).toBeNull(); expect(localStorage.getItem("resume_life_anonymize_config")).toBeNull(); expect(localStorage.getItem("resume_life_project_repo_paths_old:7")).toBeNull(); expect(sessionStorage.getItem("unrelated")).toBe("保留"); expect(localStorage.getItem("unrelated")).toBe("保留");
  });
});
