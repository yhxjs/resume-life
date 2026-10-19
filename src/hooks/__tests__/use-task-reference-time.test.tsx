// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskReferenceTime } from "../use-task-reference-time";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTaskReferenceTime", () => {
  it("使用初始化时刻，每 60 秒刷新，不因普通重渲染读取新时间", () => {
    const start = Date.now();
    const { result, rerender } = renderHook(() => useTaskReferenceTime());
    expect(result.current).toBe(start);
    act(() => vi.advanceTimersByTime(59_999));
    rerender();
    expect(result.current).toBe(start);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(start + 60_000);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(start + 120_000);
  });

  it("卸载时移除自身计时器", () => {
    const baseline = vi.getTimerCount();
    const { unmount } = renderHook(() => useTaskReferenceTime());
    expect(vi.getTimerCount()).toBe(baseline + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(baseline);
  });
});
