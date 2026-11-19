// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNotebookFavorite } from "../use-notebook-favorite";
import { HttpError, jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const input = { source: "drill" as const, sourceId: 11, question: "原题 <T> &amp;\n内部  空格", categoryId: 4 };
const review = { review_card_id: 8, review_mastery: "learning", next_review_date: "2026-11-03" };
const saved = { id: 3, source: "drill", source_id: 11, category_id: 4, question: "历史快照题目", answer: "原答", comment: "原点评", reference: "原参考", review };
const ack = { id: 3, review };

describe("收藏写入与来源只读恢复", () => {
  it("同事件只写一次，完整回包后按来源核对再通知，使用实际复习进度", async () => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(saved);
    const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed));
    await act(async () => { void hook.result.current.save(input); void hook.result.current.save({ ...input, categoryId: null }); });
    expect(jsonFetch).toHaveBeenCalledTimes(1); expect(changed).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(ack); }); expect(changed).toHaveBeenCalledExactlyOnceWith(saved);
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0]![1]!.body))).toEqual({ source: "drill", source_id: 11, category_id: 4 });
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/notebook/lookup?source=drill&source_id=11", expect.objectContaining({ cache: "no-store" }));
  });

  it.each([null, {}, { id: "3", review }, { id: 3, review: null }, { id: 3, review: { ...review, review_card_id: 0 } }])("坏成功回包 %j 按来源恢复，不重复POST", async ack => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(ack).mockResolvedValueOnce(saved); const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed));
    await act(() => hook.result.current.save(input)); expect(changed).toHaveBeenCalledExactlyOnceWith(saved);
    expect(vi.mocked(jsonFetch).mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["POST", "GET"]);
  });

  it.each([new Error("网络失败"), new HttpError("超时", 408), new HttpError("异常", 500), new HttpError("已收藏", 409)])("异常 %j 只读读取当前来源收藏", async error => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(error).mockResolvedValueOnce(saved); const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed));
    await act(() => hook.result.current.save(input)); expect(changed).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it.each([400, 401, 403, 404, 422])("明确拒绝 %s 不回读、不重写并保留原选择", async status => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("业务拒绝", status)); const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed));
    await act(() => hook.result.current.save(input)); expect(changed).not.toHaveBeenCalled(); expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.error).toBe("业务拒绝"); expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("串来源和坏读取保持未知锁，重读互斥，不能抢跑其他写入", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce({ ...saved, source_id: 12 }); const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed));
    await act(() => hook.result.current.save(input)); expect(hook.result.current.phase).toBe("unknown");
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    await act(async () => { hook.result.current.reread(); hook.result.current.reread(); void hook.result.current.save(input); hook.result.current.allowRetry(); });
    expect(jsonFetch).toHaveBeenCalledTimes(3); expect(hook.result.current.phase).toBe("checking"); expect(changed).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(saved); }); expect(changed).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("正向回包的错误收藏ID不能冒领，显式来源重读后才能恢复", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...ack, id: 99 }).mockResolvedValueOnce(saved).mockResolvedValueOnce(saved);
    const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed)); await act(() => hook.result.current.save(input));
    expect(hook.result.current.phase).toBe("unknown"); expect(changed).not.toHaveBeenCalled(); await act(async () => { hook.result.current.reread(); }); expect(changed).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("当前分类不同须显式使用现有快照，不自动移动，不按题目原文认领", async () => {
    const existing = { ...saved, category_id: null, review: null }; vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("已收藏", 409)).mockResolvedValueOnce(existing);
    const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed)); await act(() => hook.result.current.save(input));
    expect(hook.result.current.phase).toBe("existing"); expect(hook.result.current.existing).toEqual(existing); expect(changed).not.toHaveBeenCalled();
    await act(async () => { hook.result.current.useExisting(); }); expect(changed).toHaveBeenCalledExactlyOnceWith(existing); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("存在快照的旧确认不能越过正在进行的新核对", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce({ ...saved, category_id: null }); const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed)); await act(() => hook.result.current.save(input));
    const accept = hook.result.current.useExisting; const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    await act(async () => { hook.result.current.reread(); accept(); }); expect(changed).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(saved); }); expect(changed).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("未找到只允许显式解锁，不自动重投，旧重试按钮不能越过正在读取", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("未找到", 404)); const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed));
    await act(() => hook.result.current.save(input)); expect(hook.result.current.phase).toBe("missing"); expect(hook.result.current.error).toContain("稍后完成");
    const allow = hook.result.current.allowRetry; const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    await act(async () => { hook.result.current.reread(); allow(); }); expect(hook.result.current.phase).toBe("checking"); expect(hook.result.current.canStart()).toBe(false);
    await act(async () => { pending.reject(new HttpError("未找到", 404)); }); await act(async () => { hook.result.current.allowRetry(); });
    expect(hook.result.current.phase).toBe("idle"); expect(changed).not.toHaveBeenCalled(); expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("旧只读入口不能抢跑新的POST，离页取消等待且迟到结果不回调", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("未找到", 404)); const changed = vi.fn(); const hook = renderHook(() => useNotebookFavorite(changed)); await act(() => hook.result.current.save(input));
    const reread = hook.result.current.reread; await act(async () => { hook.result.current.allowRetry(); }); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    await act(async () => { void hook.result.current.save(input); reread(); }); expect(jsonFetch).toHaveBeenCalledTimes(3);
    const signal = vi.mocked(jsonFetch).mock.calls[2]![1]!.signal!; hook.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(ack); }); expect(changed).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledTimes(3);
  });
});
