// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryPickerDialog } from "../directory-picker-dialog";

const calls = vi.hoisted(() => ({ json: vi.fn(), select: vi.fn(), close: vi.fn() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: calls.json }));
const directory = (path: string) => ({ currentPath: path, parentPath: null, drives: ["C:/", "D:/"], entries: [] });
const props = { open: true, projectId: 1, initialPath: "D:/first", onClose: calls.close, onSelect: calls.select };
beforeEach(() => { calls.json.mockReset(); calls.select.mockReset(); calls.close.mockReset(); });
afterEach(cleanup);
const selectButton = () => screen.getByRole("button", { name: "确定选择当前目录" }) as HTMLButtonElement;
async function setup() {
  calls.json.mockResolvedValueOnce(directory(props.initialPath));
  const view = render(<DirectoryPickerDialog {...props} />);
  await waitFor(() => expect(selectButton().disabled).toBe(false));
  await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(1));
  return view;
}

describe("目录选择请求归属", () => {
  it("关闭后重开另一目录，旧成功回包不能替换新目录或被选中", async () => {
    const old = Promise.withResolvers<ReturnType<typeof directory>>();
    calls.json.mockReturnValueOnce(old.promise);
    const view = render(<DirectoryPickerDialog {...props} />);
    await waitFor(() => expect(calls.json).toHaveBeenCalledOnce());
    view.rerender(<DirectoryPickerDialog {...props} open={false} />);
    calls.json.mockResolvedValueOnce(directory("D:/second"));
    view.rerender(<DirectoryPickerDialog {...props} initialPath="D:/second" />);
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    await act(async () => { old.resolve(directory("D:/first")); await old.promise; });
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledWith("D:/second");
  });

  it.each(["success", "failure"])("旧盘符请求 %s 先结束，不能提前解锁新目录选择", async outcome => {
    await setup();
    const old = Promise.withResolvers<ReturnType<typeof directory>>();
    const fresh = Promise.withResolvers<ReturnType<typeof directory>>();
    calls.json.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    fireEvent.click(screen.getByRole("button", { name: "C:/" }));
    fireEvent.click(screen.getByRole("button", { name: "D:/" }));
    await act(async () => { if (outcome === "success") old.resolve(directory("C:/")); else old.reject(new Error("旧盘符不可用")); await old.promise.catch(() => {}); });
    expect(selectButton().disabled).toBe(true);
    expect(screen.queryByText(/旧盘符不可用/)).toBeNull();
    await act(async () => { fresh.resolve(directory("D:/")); await fresh.promise; });
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledWith("D:/");
  });

  it("旧盘符失败晚于新目录成功，不显示过期错误", async () => {
    await setup();
    const old = Promise.withResolvers<ReturnType<typeof directory>>();
    calls.json.mockReturnValueOnce(old.promise).mockResolvedValueOnce(directory("D:/"));
    fireEvent.click(screen.getByRole("button", { name: "C:/" }));
    fireEvent.click(screen.getByRole("button", { name: "D:/" }));
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    await act(async () => { old.reject(new Error("旧盘符失败")); await old.promise.catch(() => {}); });
    expect(screen.queryByText(/旧盘符失败/)).toBeNull();
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledWith("D:/");
  });

  it("读取失败不能选择未确认路径，重试仍请求失败目录且只读", async () => {
    calls.json.mockRejectedValueOnce(new Error("目录暂不可用"));
    render(<DirectoryPickerDialog {...props} />);
    await screen.findByText(/目录暂不可用/);
    expect(selectButton().disabled).toBe(true);
    fireEvent.click(selectButton());
    expect(calls.select).not.toHaveBeenCalled();
    calls.json.mockResolvedValueOnce(directory(props.initialPath));
    fireEvent.click(screen.getByRole("button", { name: "重试读取目录" }));
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    expect(calls.json.mock.calls.map(([url]) => url)).toEqual(Array(2).fill("/api/projects/1/scan-repo?action=browse&path=D%3A%2Ffirst"));
    expect(screen.queryByText(/目录暂不可用/)).toBeNull();
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledOnce();
    expect(calls.select).toHaveBeenCalledWith(props.initialPath);
  });

  it("切换项目时旧目录回包不能改变新项目选择", async () => {
    const old = Promise.withResolvers<ReturnType<typeof directory>>();
    calls.json.mockReturnValueOnce(old.promise);
    const view = render(<DirectoryPickerDialog {...props} />);
    await waitFor(() => expect(calls.json).toHaveBeenCalledOnce());
    calls.json.mockResolvedValueOnce(directory("D:/new-project"));
    view.rerender(<DirectoryPickerDialog {...props} projectId={2} initialPath="D:/new-project" />);
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    await act(async () => { old.resolve(directory("D:/first")); await old.promise; });
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledWith("D:/new-project");
  });

  it("旧目录成功晚于新目录，不覆盖当前路径", async () => {
    await setup();
    const old = Promise.withResolvers<ReturnType<typeof directory>>();
    calls.json.mockReturnValueOnce(old.promise).mockResolvedValueOnce(directory("D:/"));
    fireEvent.click(screen.getByRole("button", { name: "C:/" }));
    fireEvent.click(screen.getByRole("button", { name: "D:/" }));
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    await act(async () => { old.resolve(directory("C:/")); await old.promise; });
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledWith("D:/");
  });

  it("导航失败后不允许误选上一目录，重试保持失败目标", async () => {
    await setup();
    calls.json.mockRejectedValueOnce(new Error("盘符暂不可用"));
    fireEvent.click(screen.getByRole("button", { name: "C:/" }));
    await screen.findByRole("alert");
    expect(selectButton().disabled).toBe(true);
    calls.json.mockResolvedValueOnce(directory("C:/"));
    fireEvent.click(screen.getByRole("button", { name: "重试读取目录" }));
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    expect(calls.json.mock.calls[2]![0]).toBe("/api/projects/1/scan-repo?action=browse&path=C%3A%2F");
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledWith("C:/");
  });

  it("卸载时中止请求，晚到回包不触发选择", async () => {
    const old = Promise.withResolvers<ReturnType<typeof directory>>();
    calls.json.mockReturnValueOnce(old.promise);
    const view = render(<DirectoryPickerDialog {...props} />);
    await waitFor(() => expect(calls.json).toHaveBeenCalledOnce());
    const signal = calls.json.mock.calls[0]![1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { old.resolve(directory(props.initialPath)); await old.promise; });
    expect(calls.select).not.toHaveBeenCalled();
  });

  it("严格模式只发起有效会话的初始化读取", async () => {
    calls.json.mockResolvedValue(directory(props.initialPath));
    render(<React.StrictMode><DirectoryPickerDialog {...props} /></React.StrictMode>);
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    expect(calls.json).toHaveBeenCalledOnce();
    fireEvent.click(selectButton());
    expect(calls.select).toHaveBeenCalledOnce();
    expect(calls.close).toHaveBeenCalledOnce();
  });

  it("读取失败显示待确认目标，不把失败描述成空目录", async () => {
    calls.json.mockRejectedValueOnce(new Error("目录不存在，请检查路径后重试"));
    render(<DirectoryPickerDialog {...props} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("当前目录下没有子文件夹")).toBeNull();
    expect(screen.getByTitle(props.initialPath)).toBeTruthy();
    expect(screen.getByText(/待确认:/).textContent).toContain(props.initialPath);
    expect(selectButton().disabled).toBe(true);
  });

  it("列表截断时明确提示，切换到完整目录后不保留旧提示", async () => {
    calls.json.mockResolvedValueOnce({ ...directory(props.initialPath), truncated: true,
      entries: [{ name: "child", path: "D:/first/child", isDirectory: true }] });
    render(<DirectoryPickerDialog {...props} />);
    await waitFor(() => expect(selectButton().disabled).toBe(false));
    expect(screen.getByRole("status").textContent).toContain("仅显示前 1 个子文件夹");
    calls.json.mockResolvedValueOnce({ ...directory("C:/"), truncated: false });
    fireEvent.click(screen.getByRole("button", { name: "C:/" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.getByText("当前目录下没有子文件夹")).toBeTruthy();
  });
});
