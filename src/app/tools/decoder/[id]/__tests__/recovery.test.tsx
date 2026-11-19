// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

beforeEach(() => { navigation.id = "1"; vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const decoding = (id = 1) => ({ id, source_text: `原文${id}`, result: null, created_at: "2026-10-28" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const deleteButton = () => screen.getByRole("button", { name: "删除报告" });

describe("解码详情记录与删除状态隔离", () => {
  it("切换记录立即移除旧内容；新记录读取失败后只重试新记录", async () => {
    const next = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding()).mockReturnValueOnce(next.promise).mockResolvedValueOnce(decoding(2));
    const view = render(<Page />);
    await screen.findByText("报告 #1");
    navigation.id = "2";
    view.rerender(<Page />);
    expect(screen.queryByText("报告 #1")).toBeNull();
    expect(screen.queryByRole("button", { name: "删除报告" })).toBeNull();
    await act(async () => next.reject(new Error("读取第二份失败")));
    expect(screen.getByRole("alert").textContent).toContain("读取第二份失败");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByText("报告 #2");
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/jargon-decodings/2", expect.anything());
  });

  it("旧读取迟到不覆盖新记录", async () => {
    const first = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(first.promise).mockResolvedValueOnce(decoding(2));
    const view = render(<Page />);
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("报告 #2");
    await act(async () => first.resolve(decoding()));
    expect(screen.queryByText("报告 #1")).toBeNull();
  });

  it.each([
    { ...decoding(), id: 2 }, { ...decoding(), id: 1.5 }, { ...decoding(), source_text: null },
    { ...decoding(), result: { role: "残缺报告" } },
  ])("拒绝不完整或串记录响应 %#", async (value) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(value);
    render(<Page />);
    expect((await screen.findByRole("alert")).textContent).toContain("报告响应不完整");
    expect(screen.queryByRole("button", { name: "删除报告" })).toBeNull();
  });

  it("确认等待同步互斥，取消后可重新确认", async () => {
    const confirm = deferred<boolean>();
    vi.mocked(jsonFetch).mockResolvedValue(decoding());
    vi.mocked(confirmDialog).mockReturnValueOnce(confirm.promise).mockResolvedValueOnce(false);
    render(<Page />);
    await screen.findByText("报告 #1");
    act(() => { fireEvent.click(deleteButton()); fireEvent.click(deleteButton()); });
    expect(confirmDialog).toHaveBeenCalledOnce();
    await act(async () => confirm.resolve(false));
    fireEvent.click(deleteButton());
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledTimes(2));
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("切换后旧确认同意也不发送删除", async () => {
    const confirm = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(confirm.promise);
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding()).mockResolvedValueOnce(decoding(2));
    const view = render(<Page />);
    await screen.findByText("报告 #1");
    fireEvent.click(deleteButton());
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("报告 #2");
    await act(async () => confirm.resolve(true));
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each([true, false])("旧删除成功/失败不导航也不污染新记录：%s", async (success) => {
    const write = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding()).mockReturnValueOnce(write.promise).mockResolvedValueOnce(decoding(2));
    const view = render(<Page />);
    await screen.findByText("报告 #1");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(jsonFetch).mock.calls[1]?.[1]?.signal;
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("报告 #2");
    expect(signal?.aborted).toBe(true);
    await act(async () => success ? write.resolve({ ok: true }) : write.reject(new Error("旧失败")));
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it.each([new Error("响应丢失"), new HttpError("暂时不可用", 503), null, { ok: false }])("删除异常后先读取，404 才确认不存在 %#", async (response) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding());
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response);
    else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("记录不存在", 404));
    render(<Page />);
    await screen.findByText("报告 #1");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/tools/decoder"));
    expect(jsonFetch).toHaveBeenNthCalledWith(3, "/api/tools/jargon-decodings/1", expect.objectContaining({ cache: "no-store" }));
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("核对仍存在保留失败原因，允许显式再次删除", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding()).mockRejectedValueOnce(new Error("删除响应损坏"))
      .mockResolvedValueOnce(decoding()).mockResolvedValueOnce({ ok: true });
    render(<Page />);
    await screen.findByText("报告 #1");
    fireEvent.click(deleteButton());
    expect((await screen.findByRole("alert")).textContent).toContain("删除响应损坏；已重新读取，记录目前仍存在");
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(deleteButton());
    await waitFor(() => expect(navigation.push).toHaveBeenCalledOnce());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
  });

  it("连续核对失败或串记录时保持锁定，重读互斥且只读不重复删除", async () => {
    const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding()).mockRejectedValueOnce(new Error("响应丢失"))
      .mockRejectedValueOnce(new Error("核对失败"))
      .mockReturnValueOnce(read.promise).mockRejectedValueOnce(new HttpError("记录不存在", 404));
    render(<Page />);
    await screen.findByText("报告 #1");
    fireEvent.click(deleteButton());
    await screen.findByRole("button", { name: "重新读取删除状态" });
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      const retry = screen.getByRole("button", { name: "重新读取删除状态" });
      fireEvent.click(retry); fireEvent.click(retry); fireEvent.click(deleteButton());
    });
    expect(jsonFetch).toHaveBeenCalledTimes(4);
    await act(async () => read.resolve(decoding(2)));
    expect(screen.queryByText("报告 #2")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("记录不符");
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledOnce());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("明确拒绝删除直接展示错误，允许重新确认", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding()).mockRejectedValueOnce(new HttpError("禁止删除", 403));
    render(<Page />);
    await screen.findByText("报告 #1");
    fireEvent.click(deleteButton());
    expect((await screen.findByRole("alert")).textContent).toBe("禁止删除");
    expect((deleteButton() as HTMLButtonElement).disabled).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("切换后旧删除状态读取不导航、不覆盖新记录：%s", async (missing) => {
    const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(decoding()).mockRejectedValueOnce(new Error("响应丢失"))
      .mockReturnValueOnce(read.promise).mockResolvedValueOnce(decoding(2));
    const view = render(<Page />);
    await screen.findByText("报告 #1");
    fireEvent.click(deleteButton());
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    navigation.id = "2";
    view.rerender(<Page />);
    await screen.findByText("报告 #2");
    await act(async () => missing ? read.reject(new HttpError("记录不存在", 404)) : read.resolve(decoding()));
    expect(screen.queryByText("报告 #1")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
