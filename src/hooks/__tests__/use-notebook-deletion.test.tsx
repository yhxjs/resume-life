// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useNotebookDeletion } from "../use-notebook-deletion";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const target = { id: 7, question: "  原题 <T> &amp;\n内部  空格".repeat(500), source: "drill" as const, source_label: "已删除的来源", category_name: null };
const snapshot = { id: 7, question: target.question, answer: "旧答案\n".repeat(10000), comment: "", reference: "" };

describe("错题移出恢复", () => {
  it("同步锁定确认并显示完整对象、级联历史和唯一副本风险，取消零写入", async () => {
    const decision = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(decision.promise);
    const hook = renderHook(() => useNotebookDeletion(vi.fn())); let operation!: Promise<void>;
    act(() => { operation = hook.result.current.remove(target); void hook.result.current.remove({ ...target, id: 8 }); });
    expect(confirmDialog).toHaveBeenCalledOnce(); const options = vi.mocked(confirmDialog).mock.calls[0]![0];
    expect(options.confirmText).toBe("移出");
    for (const text of ["#7", target.question, target.source_label, "未分类", "复习历史", "求职准备关联", "可能是唯一副本"]) expect(options.message).toContain(text);
    expect(options.message).not.toContain("原始作答与批改记录仍保留"); expect(hook.result.current.canStart()).toBe(false);
    await act(async () => { decision.resolve(false); await operation; });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(hook.result.current.canStart()).toBe(true);
  });

  it.each([new Error("断线"), new HttpError("超时", 408), new HttpError("失败", 503), null, [], {}, { ok: "true" }, { ok: false }])("异常响应 %# 核对同一原始快照，不自动重复移出", async response => {
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response); else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    vi.mocked(jsonFetch).mockResolvedValueOnce(snapshot); const original = structuredClone(snapshot); const refresh = vi.fn(); const hook = renderHook(() => useNotebookDeletion(refresh));
    await act(() => hook.result.current.remove(target));
    expect(hook.result.current.error).toContain("错题 #7 目前仍存在"); expect(hook.result.current.canStart()).toBe(true); expect(hook.result.current.deletedIds.size).toBe(0);
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/notebook/7", expect.objectContaining({ cache: "no-store" }));
    expect(refresh).not.toHaveBeenCalled(); expect(snapshot).toEqual(original);
  });

  it.each([null, [], {}, { ...snapshot, id: 8 }, { ...snapshot, answer: null }, { ...snapshot, comment: undefined }, { ...snapshot, reference: [] }])("核对坏字段或串记录 %# 保持未知锁", async response => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce(response); const hook = renderHook(() => useNotebookDeletion(vi.fn()));
    await act(() => hook.result.current.remove(target)); expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.error).toContain("读取响应不完整或记录不符");
    await act(() => hook.result.current.remove({ ...target, id: 8 })); expect(confirmDialog).toHaveBeenCalledOnce(); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 409, 422])("明确拒绝 %s 保留快照并允许修正", async status => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", status)); const hook = renderHook(() => useNotebookDeletion(vi.fn()));
    await act(() => hook.result.current.remove(target)); expect(hook.result.current.canStart()).toBe(true); expect(hook.result.current.error).toContain("明确拒绝"); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each(["ok", "delete404", "read404"])("确认不存在 %s 后登记墓碑并只刷新一次", async mode => {
    if (mode === "ok") vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true });
    else if (mode === "delete404") vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404));
    else vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("不存在", 404));
    const refresh = vi.fn(); const hook = renderHook(() => useNotebookDeletion(refresh)); await act(() => hook.result.current.remove(target));
    expect(refresh).toHaveBeenCalledOnce(); expect(hook.result.current.deletedIds.has(7)).toBe(true); expect(hook.result.current.notice).toContain("已请求刷新错题列表及分类统计");
    await act(() => hook.result.current.remove(target)); expect(confirmDialog).toHaveBeenCalledOnce();
  });

  it("重读同步去重，失败后维持锁，完成只调用最新回调", async () => {
    const pending = Promise.withResolvers<unknown>(); const old = vi.fn(); const latest = vi.fn();
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("读取失败", 503)).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ refresh }) => useNotebookDeletion(refresh), { initialProps: { refresh: old } }); await act(() => hook.result.current.remove(target));
    act(() => { hook.result.current.retryCheck(); hook.result.current.retryCheck(); }); expect(jsonFetch).toHaveBeenCalledTimes(3); hook.rerender({ refresh: latest });
    await act(async () => { pending.reject(new HttpError("不存在", 404)); }); expect(latest).toHaveBeenCalledOnce(); expect(old).not.toHaveBeenCalled();
  });

  it.each(["confirm", "delete", "check"])("离页中止 %s，旧入口和迟到结果不影响新实例", async phase => {
    const pending = Promise.withResolvers<unknown>(); const refresh = vi.fn();
    if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise as Promise<boolean>);
    if (phase === "delete") vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    if (phase === "check") vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockReturnValueOnce(pending.promise);
    const old = renderHook(() => useNotebookDeletion(refresh)); const methods = old.result.current; let operation!: Promise<void>;
    act(() => { operation = methods.remove(target); }); if (phase !== "confirm") await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "check" ? 2 : 1));
    const signal = phase === "confirm" ? vi.mocked(confirmDialog).mock.lastCall?.[0].signal : vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal;
    old.unmount(); expect(signal?.aborted).toBe(true);
    const next = renderHook(() => useNotebookDeletion(refresh));
    await act(async () => { pending.resolve(phase === "confirm" ? true : snapshot); await operation; await methods.remove(target); methods.retryCheck(); });
    expect(refresh).not.toHaveBeenCalled(); expect(next.result.current.canStart()).toBe(true); expect(next.result.current.deletedIds.size).toBe(0);
  });
});
