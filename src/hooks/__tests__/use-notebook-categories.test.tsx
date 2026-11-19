// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonFetch } from "@/lib/fetcher";
import { useNotebookCategories } from "../use-notebook-categories";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const saved = [{ id: 1, name: "  原分类 <T> &amp;\n".repeat(20), entry_count: 3 }];

describe("错题目录分类读取", () => {
  it.each([null, {}, [null], [{ id: 0, name: "坏分类", entry_count: 0 }], [{ ...saved[0], name: null }], [{ ...saved[0], entry_count: -1 }], [{ ...saved[0], entry_count: "3" }], [...saved, ...saved]])("拒绝整份坏响应 %#，保留已有分类并允许重新加载", async response => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved).mockResolvedValueOnce(response).mockResolvedValueOnce([]);
    const hook = renderHook(() => useNotebookCategories()); await waitFor(() => expect(hook.result.current.categories).toEqual(saved));
    act(() => hook.result.current.reload()); await waitFor(() => expect(hook.result.current.error).toContain("分类响应不完整"));
    expect(hook.result.current.categories).toEqual(saved);
    act(() => hook.result.current.reload()); await waitFor(() => expect(hook.result.current.categories).toEqual([])); expect(hook.result.current.error).toBe("");
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/notebook/categories", expect.objectContaining({ cache: "no-store" }));
  });

  it("新读取中止旧请求，迟到旧统计不能覆盖最新结果", async () => {
    const first = Promise.withResolvers<unknown>(); const latest = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    const hook = renderHook(() => useNotebookCategories()); const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!;
    act(() => hook.result.current.reload()); expect(signal.aborted).toBe(true);
    await act(async () => { latest.resolve(saved); }); await act(async () => { first.resolve([{ id: 2, name: "过期分类", entry_count: 99 }]); });
    expect(hook.result.current.categories).toEqual(saved); expect(hook.result.current.error).toBe("");
  });

  it("离页取消请求，迟到失败不能污染新实例", async () => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(saved);
    const old = renderHook(() => useNotebookCategories()); const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!; old.unmount(); expect(signal.aborted).toBe(true);
    const next = renderHook(() => useNotebookCategories()); await waitFor(() => expect(next.result.current.categories).toEqual(saved));
    await act(async () => { pending.reject(new Error("旧请求失败")); }); expect(next.result.current.error).toBe("");
  });
});
