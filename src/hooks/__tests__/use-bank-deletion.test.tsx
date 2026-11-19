// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useBankDeletion } from "../use-bank-deletion";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const saved = { id: 7, direction: "", kind: "legacy", question: "  原题 <T> &amp;\n".repeat(500), created_at: "旧时间" };

describe("题库删除状态机", () => {
  it.each([new Error("连接断开"), new HttpError("请求超时", 408), new HttpError("内部异常", 500), null, [], {}, { ok: false }, { ok: "true" }])("写入异常 %# 先核对，原题仍在则保留，不自动重删", async response => {
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response);
    else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
    const refresh = vi.fn(); const hook = renderHook(() => useBankDeletion(refresh));
    await act(() => hook.result.current.remove(saved));
    expect(hook.result.current.canStart()).toBe(true); expect(hook.result.current.error).toContain("题目 #7 目前仍存在");
    expect(hook.result.current.deletedIds.size).toBe(0); expect(refresh).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/bank/7", expect.objectContaining({ cache: "no-store" }));
    expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain(saved.question);
    expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain("未指定方向");
  });

  it.each([400, 401, 403, 409, 422])("明确拒绝 %s 保留题目并允许修正，不读库猜测", async status => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", status));
    const refresh = vi.fn(); const hook = renderHook(() => useBankDeletion(refresh));
    await act(() => hook.result.current.remove(saved));
    expect(hook.result.current.canStart()).toBe(true); expect(hook.result.current.error).toContain("明确拒绝");
    expect(refresh).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("核对重试同步去重，成功后墓碑保留且刷新只调用最新回调", async () => {
    const check = Promise.withResolvers<unknown>(); const first = vi.fn(); const latest = vi.fn();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new HttpError("读取失败", 503)).mockReturnValueOnce(check.promise);
    const hook = renderHook(({ refresh }) => useBankDeletion(refresh), { initialProps: { refresh: first } });
    await act(() => hook.result.current.remove(saved)); expect(hook.result.current.canStart()).toBe(false);
    act(() => { hook.result.current.retryCheck(); hook.result.current.retryCheck(); void hook.result.current.remove({ ...saved, id: 8 }); });
    expect(jsonFetch).toHaveBeenCalledTimes(3); hook.rerender({ refresh: latest });
    await act(async () => { check.reject(new HttpError("不存在", 404)); });
    await waitFor(() => expect(latest).toHaveBeenCalledOnce()); expect(first).not.toHaveBeenCalled();
    expect(hook.result.current.deletedIds.has(7)).toBe(true); expect(hook.result.current.notice).toBe("已确认题目 #7 不存在，已请求刷新题库列表。");
    await act(() => hook.result.current.remove(saved)); expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["confirm", "delete", "check"])("离页时中止 %s，迟到结果及旧入口不能影响新页面", async phase => {
    const pending = Promise.withResolvers<unknown>(); const oldRefresh = vi.fn(); const newRefresh = vi.fn();
    if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise as Promise<boolean>);
    if (phase === "delete") vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    if (phase === "check") vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false }).mockReturnValueOnce(pending.promise);
    const old = renderHook(() => useBankDeletion(oldRefresh)); const oldMethods = old.result.current;
    let operation!: Promise<void>; act(() => { operation = old.result.current.remove(saved); });
    if (phase !== "confirm") await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "check" ? 2 : 1));
    const signal = phase === "confirm" ? vi.mocked(confirmDialog).mock.lastCall?.[0].signal : vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal;
    old.unmount(); expect(signal?.aborted).toBe(true);
    const next = renderHook(() => useBankDeletion(newRefresh));
    await act(async () => { pending.resolve(phase === "confirm" ? true : saved); await operation; await oldMethods.remove(saved); oldMethods.retryCheck(); });
    expect(oldRefresh).not.toHaveBeenCalled(); expect(newRefresh).not.toHaveBeenCalled();
    expect(next.result.current.canStart()).toBe(true); expect(next.result.current.deletedIds.size).toBe(0);
    expect(jsonFetch).toHaveBeenCalledTimes(phase === "confirm" ? 0 : phase === "check" ? 2 : 1);
  });
});
