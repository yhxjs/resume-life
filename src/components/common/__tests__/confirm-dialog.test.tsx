// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertDialog, confirmDialog, ConfirmDialogHost } from "../confirm-dialog";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("全局确认队列与任务取消", () => {
  it("宿主不存在时立即拒绝确认，不保留隐藏队列", async () => {
    expect(await confirmDialog({ message: "无宿主" })).toBe(false);
    render(<ConfirmDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("普通确认和提示仍依次显示并分别结算", async () => {
    render(<ConfirmDialogHost />);
    let first!: Promise<boolean>;
    let second!: Promise<void>;
    act(() => {
      first = confirmDialog({ title: "第一项", message: "确认正文" });
      second = alertDialog({ title: "第二项", message: "提示正文" });
    });
    expect(screen.getByRole("dialog").textContent).toContain("第一项");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(await first).toBe(true);
    expect(screen.getByRole("dialog").textContent).toContain("第二项");
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await second;
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("请求已取消时不显示确认框并立即返回false", async () => {
    render(<ConfirmDialogHost />);
    const controller = new AbortController();
    controller.abort();
    let result: boolean | undefined;
    await act(async () => { void confirmDialog({ message: "不应显示", signal: controller.signal }).then(value => { result = value; }); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(result).toBe(false);
  });

  it("取消正在显示的确认只拒绝本项，继续下一项", async () => {
    render(<ConfirmDialogHost />);
    const controller = new AbortController();
    let first!: Promise<boolean>;
    let next!: Promise<boolean>;
    act(() => {
      first = confirmDialog({ message: "旧任务", signal: controller.signal });
      next = confirmDialog({ message: "下一项" });
    });
    await act(async () => { controller.abort(new Error("PRIVATE_ABORT_REASON")); });
    expect(screen.queryByText("旧任务")).toBeNull();
    expect(await first).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("下一项");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(await next).toBe(true);
  });

  it("取消排队项不关闭当前框，也不在轮到它时再次显示", async () => {
    render(<ConfirmDialogHost />);
    const controller = new AbortController();
    let cancelled: boolean | undefined;
    act(() => {
      void confirmDialog({ message: "其他操作" });
      void confirmDialog({ message: "过期排队项", signal: controller.signal }).then(value => { cancelled = value; });
      void confirmDialog({ message: "后续有效项" });
    });
    await act(async () => { controller.abort(); });
    expect(cancelled).toBe(false);
    expect(screen.getByRole("dialog").textContent).toContain("其他操作");
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("dialog").textContent).toContain("后续有效项");
    expect(screen.queryByText("过期排队项")).toBeNull();
  });

  it("取消后同一帧旧按钮的点击不能确认队列里的下一项", async () => {
    render(<ConfirmDialogHost />);
    const controller = new AbortController();
    let first: boolean | undefined;
    let next: boolean | undefined;
    act(() => {
      void confirmDialog({ message: "已取消任务", signal: controller.signal }).then(value => { first = value; });
      void confirmDialog({ message: "不得误确认" }).then(value => { next = value; });
    });
    const oldButton = screen.getByRole("button", { name: "确定" });
    await act(async () => {
      controller.abort();
      fireEvent.click(oldButton);
    });
    expect(first).toBe(false);
    expect(next).toBeUndefined();
    expect(screen.getByRole("dialog").textContent).toContain("不得误确认");
  });

  it("确认完成时移除取消监听，旧取消不影响后续确认", async () => {
    render(<ConfirmDialogHost />);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    act(() => { void confirmDialog({ message: "将完成", signal: controller.signal }); });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    act(() => { void confirmDialog({ message: "新的确认" }); controller.abort(); });
    expect(screen.getByRole("dialog").textContent).toContain("新的确认");
  });

  it("宿主卸载结算当前和排队项并清理全部监听", async () => {
    const host = render(<ConfirmDialogHost />);
    const controllers = [new AbortController(), new AbortController()];
    const removes = controllers.map(controller => vi.spyOn(controller.signal, "removeEventListener"));
    const results: Promise<boolean>[] = [];
    act(() => { for (const [index, controller] of controllers.entries()) results.push(confirmDialog({ message: `旧项${index}`, signal: controller.signal })); });
    host.unmount();
    expect(await Promise.all(results)).toEqual([false, false]);
    for (const remove of removes) expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    render(<ConfirmDialogHost />);
    act(() => { void confirmDialog({ message: "新宿主确认" }); for (const controller of controllers) controller.abort(); });
    expect(screen.getByRole("dialog").textContent).toContain("新宿主确认");
  });

  it("取消已展示的提示会结算本项，并保留排队确认", async () => {
    render(<ConfirmDialogHost />);
    const controller = new AbortController(); let finished = false;
    act(() => {
      void alertDialog({ title: "所属页面的失败", message: "旧提示", signal: controller.signal }).then(() => { finished = true; });
      void confirmDialog({ title: "后续有效确认", message: "必须另行确认" });
    });
    await act(async () => { controller.abort(); });
    expect(finished).toBe(true); expect(screen.queryByText("旧提示")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("后续有效确认");
  });

  it("提示在入队前已取消或排队中被取消时不残留，也不关闭当前项", async () => {
    render(<ConfirmDialogHost />);
    const cancelled = new AbortController(); cancelled.abort();
    await act(async () => { await alertDialog({ message: "不应显示", signal: cancelled.signal }); });
    expect(screen.queryByRole("dialog")).toBeNull();
    const queued = new AbortController(); let finished = false;
    act(() => {
      void confirmDialog({ title: "当前有效项", message: "继续处理" });
      void alertDialog({ message: "过期排队提示", signal: queued.signal }).then(() => { finished = true; });
    });
    await act(async () => { queued.abort(); });
    expect(finished).toBe(true); expect(screen.getByRole("dialog").textContent).toContain("当前有效项");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
