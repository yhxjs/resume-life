// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyFeedback } from "../use-copy-feedback";

const writeText = vi.fn<(text: string) => Promise<void>>();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("复制反馈的异步边界", () => {
  it("逐字复制换行、实体与事实条件，成功提示只保持指定时间", async () => {
    const { result } = renderHook(() => useCopyFeedback(100));
    const text = "原文 <T> &amp;\n尚未上线，也未确认到岗条件。";
    await act(async () => { expect(await result.current.copy(text)).toBe(true); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(result.current).toMatchObject({ copiedText: text, copyError: null, copying: false });
    act(() => vi.advanceTimersByTime(99));
    expect(result.current.copiedText).toBe(text);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.copiedText).toBeNull();
  });

  it("重试一开始清除旧成功状态；失败就近反馈，成功重试再清除失败", async () => {
    const { result } = renderHook(() => useCopyFeedback());
    const text = "尚未确认";
    await act(async () => { await result.current.copy(text); });
    const pending = deferred();
    writeText.mockReturnValueOnce(pending.promise);
    let copy!: Promise<boolean>;
    act(() => { copy = result.current.copy(text); });
    expect(result.current).toMatchObject({ copiedText: null, copyError: null, copying: true });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { pending.reject(new Error("denied")); expect(await copy).toBe(false); });
    expect(result.current).toMatchObject({ copiedText: null, copying: false, copyError: { text } });
    expect(result.current.copyError?.message).toContain("手动复制");
    await act(async () => { expect(await result.current.copy(text)).toBe(true); });
    expect(result.current).toMatchObject({ copiedText: text, copyError: null, copying: false });
  });

  it("同一时刻只允许一次写入，未受理的另一段不会被标为已复制，完成后可复制", async () => {
    const { result } = renderHook(() => useCopyFeedback());
    const pending = deferred();
    writeText.mockReturnValueOnce(pending.promise);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.copy("第一段原文");
      second = result.current.copy("第二段原文");
    });
    expect(await second).toBe(false);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("第一段原文");
    expect(result.current.copying).toBe(true);
    await act(async () => { pending.resolve(); expect(await first).toBe(true); });
    expect(result.current.copiedText).toBe("第一段原文");
    await act(async () => { expect(await result.current.copy("第二段原文")).toBe(true); });
    expect(result.current.copiedText).toBe("第二段原文");
  });

  it.each([true, false])("卸载后在途写入%s不创建定时器，保留的旧处理函数也不再写剪贴板", async (success) => {
    const pending = deferred();
    writeText.mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() => useCopyFeedback());
    const staleCopy = result.current.copy;
    let copy!: Promise<boolean>;
    act(() => { copy = staleCopy("原文"); });
    unmount();
    if (success) pending.resolve(); else pending.reject(new Error("denied"));
    expect(await copy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(await staleCopy("卸载后的另一段")).toBe(false);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("卸载时清除成功定时器，StrictMode 的重复挂载检查不阻止正常复制", async () => {
    const { result, unmount } = renderHook(() => useCopyFeedback(), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    await act(async () => { expect(await result.current.copy("原文")).toBe(true); });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("剪贴板 API 缺失时返回可恢复错误，而不是未处理异常或默认成功", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => { expect(await result.current.copy("原话")).toBe(false); });
    expect(result.current).toMatchObject({ copiedText: null, copying: false, copyError: { text: "原话" } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
