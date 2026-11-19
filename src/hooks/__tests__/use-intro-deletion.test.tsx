// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useIntroDeletion } from "../use-intro-deletion";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const item = { id: 7, jd: "  原始岗位 <T> &amp;\n内部  空格  ".repeat(500), resume_title: "完整简历_".repeat(100), created_at: "旧时间", resume_version_id: 11, resume_version: 2, resume_version_name: "原始发布版 <T> &amp;" };
const detail = () => ({ ...item, resume_id: 1, versions: [{ kind: "30s", revision: "a".repeat(64), sentences: [{ text: "长历史原稿 <T> &amp;\n".repeat(500), comment: "原点评" }] }] });

describe("自我介绍删除恢复", () => {
  it.each([false, true])("确认完整对象与两版级联范围，取消零写入；未绑定旧记录=%s", async legacy => {
    const decision = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(decision.promise);
    const target = legacy ? { ...item, resume_version_id: null, resume_version: null, resume_version_name: null } : item;
    const refresh = vi.fn(); const hook = renderHook(() => useIntroDeletion(refresh)); let operation!: Promise<void>;
    act(() => { operation = hook.result.current.remove(target); void hook.result.current.remove({ ...item, id: 8 }); });
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(hook.result.current.canStart()).toBe(false);
    const message = vi.mocked(confirmDialog).mock.calls[0]![0].message;
    for (const text of ["#7", item.jd, item.resume_title, item.created_at, "两版介绍与逐句点评", legacy ? "未绑定发布版" : item.resume_version_name]) expect(message).toContain(text);
    await act(async () => { decision.resolve(false); await operation; });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(hook.result.current.canStart()).toBe(true);
  });

  it.each([new Error("断线"), new HttpError("超时", 408), new HttpError("失败", 503), null, [], {}, { ok: false }, { ok: "true" }])("异常响应 %# 核对同一存档，仍存在只释放锁不自动重删", async response => {
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response);
    else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const saved = detail(); const original = structuredClone(saved); vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
    const refresh = vi.fn(); const hook = renderHook(() => useIntroDeletion(refresh)); await act(() => hook.result.current.remove(item));
    expect(hook.result.current.error).toContain("自我介绍 #7 目前仍存在"); expect(hook.result.current.canStart()).toBe(true);
    expect(hook.result.current.deletedIds.size).toBe(0); expect(refresh).not.toHaveBeenCalled(); expect(saved).toEqual(original);
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/intros/7", expect.objectContaining({ cache: "no-store" }));
  });

  it.each([null, [], {}, { ...detail(), id: 8 }, { ...detail(), resume_id: 0 }, { ...detail(), resume_version: null }, { ...detail(), versions: [null] },
    { ...detail(), versions: [{ kind: "30s", revision: "a".repeat(64), sentences: [] }] },
  ])("核对损坏或串记录 %# 保持未知锁，仅允许重读", async response => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce(response);
    const refresh = vi.fn(); const hook = renderHook(() => useIntroDeletion(refresh)); await act(() => hook.result.current.remove(item));
    expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.error).toContain("读取响应不完整或记录不符");
    await act(() => hook.result.current.remove({ ...item, id: 8 }));
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(jsonFetch).toHaveBeenCalledTimes(2); expect(refresh).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 409, 422])("明确拒绝 %s 直接保留存档并展示错误", async status => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", status));
    const hook = renderHook(() => useIntroDeletion(vi.fn())); await act(() => hook.result.current.remove(item));
    expect(hook.result.current.canStart()).toBe(true); expect(hook.result.current.error).toContain("明确拒绝"); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each(["ok", "delete404", "read404"])("确认不存在 %s 仅刷新一次并阻止旧入口重复删除", async mode => {
    if (mode === "ok") vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true });
    else if (mode === "delete404") vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404));
    else vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("不存在", 404));
    const refresh = vi.fn(); const hook = renderHook(() => useIntroDeletion(refresh)); await act(() => hook.result.current.remove(item));
    expect(refresh).toHaveBeenCalledOnce(); expect(hook.result.current.deletedIds.has(7)).toBe(true);
    expect(hook.result.current.notice).toBe("已确认自我介绍 #7 不存在，已请求刷新自我介绍历史。");
    await act(() => hook.result.current.remove(item)); expect(confirmDialog).toHaveBeenCalledOnce();
  });

  it("显式重读同步去重，使用最新刷新回调", async () => {
    const pending = Promise.withResolvers<unknown>(); const first = vi.fn(); const latest = vi.fn();
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("读取失败", 503)).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ refresh }) => useIntroDeletion(refresh), { initialProps: { refresh: first } }); await act(() => hook.result.current.remove(item));
    act(() => { hook.result.current.retryCheck(); hook.result.current.retryCheck(); void hook.result.current.remove({ ...item, id: 8 }); });
    expect(jsonFetch).toHaveBeenCalledTimes(3); hook.rerender({ refresh: latest });
    await act(async () => { pending.reject(new HttpError("不存在", 404)); });
    expect(latest).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled(); expect(hook.result.current.canStart()).toBe(true);
  });

  it.each(["confirm", "delete", "check"])("离页中止 %s，迟到结果不刷新新实例", async phase => {
    const pending = Promise.withResolvers<unknown>(); const refresh = vi.fn();
    if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise as Promise<boolean>);
    if (phase === "delete") vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    if (phase === "check") vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockReturnValueOnce(pending.promise);
    const old = renderHook(() => useIntroDeletion(refresh)); const methods = old.result.current; let operation!: Promise<void>;
    act(() => { operation = methods.remove(item); });
    if (phase !== "confirm") await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "check" ? 2 : 1));
    const signal = phase === "confirm" ? vi.mocked(confirmDialog).mock.lastCall?.[0].signal : vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal;
    old.unmount(); expect(signal?.aborted).toBe(true);
    const next = renderHook(() => useIntroDeletion(refresh));
    await act(async () => { pending.resolve(phase === "confirm" ? true : { ok: true }); await operation; await methods.remove(item); methods.retryCheck(); });
    expect(refresh).not.toHaveBeenCalled(); expect(next.result.current.deletedIds.size).toBe(0); expect(next.result.current.canStart()).toBe(true);
  });
});
