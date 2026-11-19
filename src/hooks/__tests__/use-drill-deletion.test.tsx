// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useDrillDeletion } from "../use-drill-deletion";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const item = { id: 7, source: "bank", direction: "", jd: "  原始岗位 <T> &amp;\n".repeat(500), focus: "待核实", project_name: null, created_at: "旧时间", total: 1, answered: 0 };
const detail = () => ({ ...item, project_id: null, interview_id: null, questions: [{ id: 70, idx: 0, question: "历史问题\n".repeat(5000), answer: "原答", comment: "", reference: "", kind: "legacy", answered_at: "" }] });

describe("练习删除恢复", () => {
  it.each([
    { source: "project", project_name: "  完整项目 <T> &amp;\n".repeat(300), expected: "项目：" },
    { source: "project", project_name: null, expected: "项目：未命名项目" },
    { source: "interview", project_name: null, expected: "面试追练" },
  ])("$source 确认保留完整项目和追练背景", async ({ expected, ...patch }) => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    const hook = renderHook(() => useDrillDeletion(vi.fn()));
    await act(() => hook.result.current.remove({ ...item, ...patch }));
    const message = vi.mocked(confirmDialog).mock.calls[0]![0].message;
    expect(message).toContain(expected); if (patch.project_name) expect(message).toContain(patch.project_name);
    expect(message).toContain(item.focus); expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("从确认开始同步互斥，取消零写入；确认显示完整对象及真实级联范围", async () => {
    const decision = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(decision.promise);
    const refresh = vi.fn(); const hook = renderHook(() => useDrillDeletion(refresh)); let operation!: Promise<void>;
    act(() => { operation = hook.result.current.remove(item); void hook.result.current.remove({ ...item, id: 8 }); });
    expect(hook.result.current.canStart()).toBe(false); expect(confirmDialog).toHaveBeenCalledOnce();
    const message = vi.mocked(confirmDialog).mock.calls[0]![0].message;
    for (const expected of ["#7", item.jd, item.created_at, "未指定", "直接关联的复习记录", "已收藏到错题本的快照及其复习记录仍保留"]) expect(message).toContain(expected);
    await act(async () => { decision.resolve(false); await operation; });
    expect(jsonFetch).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(hook.result.current.canStart()).toBe(true);
  });

  it.each([new Error("断线"), new HttpError("超时", 408), new HttpError("失败", 503), null, [], {}, { ok: false }, { ok: "true" }])("异常响应 %# 只读核对同一完整存档，不自动重删", async response => {
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response);
    else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const saved = detail(); const original = structuredClone(saved); vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
    const refresh = vi.fn(); const hook = renderHook(() => useDrillDeletion(refresh));
    await act(() => hook.result.current.remove(item));
    expect(hook.result.current.error).toContain("练习 #7 目前仍存在"); expect(hook.result.current.canStart()).toBe(true);
    expect(hook.result.current.deletedIds.size).toBe(0); expect(refresh).not.toHaveBeenCalled(); expect(saved).toEqual(original);
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/drills/7", expect.objectContaining({ cache: "no-store" }));
  });

  it.each([null, [], {}, { ...detail(), id: 8 }, { ...detail(), project_id: 0 }, { ...detail(), interview_id: -1 }, { ...detail(), questions: [null] }, { ...detail(), questions: [{ id: 70 }] }])("核对坏结构或串记录 %# 保持未知锁，只能显式重读", async response => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce(response);
    const refresh = vi.fn(); const hook = renderHook(() => useDrillDeletion(refresh));
    await act(() => hook.result.current.remove(item));
    expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.error).toContain("读取响应不完整或记录不符");
    await act(() => hook.result.current.remove({ ...item, id: 8 }));
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(jsonFetch).toHaveBeenCalledTimes(2); expect(refresh).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 409, 422])("明确拒绝 %s 不猜测删除成功", async status => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", status));
    const hook = renderHook(() => useDrillDeletion(vi.fn())); await act(() => hook.result.current.remove(item));
    expect(hook.result.current.canStart()).toBe(true); expect(hook.result.current.error).toContain("明确拒绝"); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each(["ok", "delete404", "read404"])("确认不存在 %s 后只刷新一次，墓碑阻止旧入口，状态不冒充持续加载", async mode => {
    if (mode === "ok") vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true });
    else if (mode === "delete404") vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404));
    else vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("不存在", 404));
    const refresh = vi.fn(); const hook = renderHook(() => useDrillDeletion(refresh)); await act(() => hook.result.current.remove(item));
    expect(refresh).toHaveBeenCalledOnce(); expect(hook.result.current.deletedIds.has(7)).toBe(true);
    expect(hook.result.current.notice).toBe("已确认练习 #7 不存在，已请求刷新练习列表。");
    await act(() => hook.result.current.remove(item)); expect(confirmDialog).toHaveBeenCalledOnce();
  });

  it("显式重读同步去重，只用最新刷新回调", async () => {
    const pending = Promise.withResolvers<unknown>(); const first = vi.fn(); const latest = vi.fn();
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("读取失败", 503)).mockReturnValueOnce(pending.promise);
    const hook = renderHook(({ refresh }) => useDrillDeletion(refresh), { initialProps: { refresh: first } });
    await act(() => hook.result.current.remove(item));
    act(() => { hook.result.current.retryCheck(); hook.result.current.retryCheck(); void hook.result.current.remove({ ...item, id: 8 }); });
    expect(jsonFetch).toHaveBeenCalledTimes(3); hook.rerender({ refresh: latest });
    await act(async () => { pending.reject(new HttpError("不存在", 404)); });
    expect(latest).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled(); expect(hook.result.current.canStart()).toBe(true);
  });

  it.each(["confirm", "delete", "check"])("离页中止 %s，旧入口和迟到结果不能影响新实例", async phase => {
    const pending = Promise.withResolvers<unknown>(); const refresh = vi.fn();
    if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise as Promise<boolean>);
    if (phase === "delete") vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    if (phase === "check") vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockReturnValueOnce(pending.promise);
    const old = renderHook(() => useDrillDeletion(refresh)); const methods = old.result.current; let operation!: Promise<void>;
    act(() => { operation = methods.remove(item); });
    if (phase !== "confirm") await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "check" ? 2 : 1));
    const signal = phase === "confirm" ? vi.mocked(confirmDialog).mock.lastCall?.[0].signal : vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal;
    old.unmount(); expect(signal?.aborted).toBe(true);
    const next = renderHook(() => useDrillDeletion(refresh));
    await act(async () => { pending.resolve(phase === "confirm" ? true : detail()); await operation; await methods.remove(item); methods.retryCheck(); });
    expect(refresh).not.toHaveBeenCalled(); expect(next.result.current.deletedIds.size).toBe(0); expect(next.result.current.canStart()).toBe(true);
  });
});
