// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useNotebookCategoryCommand, type NotebookCategoryCommand } from "../use-notebook-category-command";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const inputs: NotebookCategoryCommand[] = [
  { kind: "create", name: "  原名 <T> &amp;  " }, { kind: "rename", id: 1, name: "  新名 <T> &amp;  " },
  { kind: "move", id: 5, categoryId: 1, question: "  原题 <T> &amp;\n".repeat(2000) },
  { kind: "delete", id: 1, name: "原分类 <T> &amp;", entryCount: 2 },
];
const category = { id: 1, name: "新名 <T> &amp;", entry_count: 2 };
const snapshot = { id: 5, question: "原题", answer: "", comment: "", reference: "", category_id: 1 };

describe("分类命令固定对象与只读恢复", () => {
  it.each(inputs)("%j 同事件只提交一次，完整确认后才回调", async input => {
    const pending = Promise.withResolvers<unknown>();
    if (input.kind === "create") vi.mocked(jsonFetch).mockResolvedValueOnce([]).mockReturnValueOnce(pending.promise);
    else vi.mocked(jsonFetch).mockReturnValue(pending.promise);
    const completed = vi.fn(); const locked = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed, locked));
    await act(async () => { void hook.result.current.run(input); void hook.result.current.run(input); });
    expect(jsonFetch).toHaveBeenCalledTimes(input.kind === "create" ? 2 : 1); expect(hook.result.current.busy).toBe(true); expect(locked).toHaveBeenLastCalledWith(true); expect(completed).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(input.kind === "create" ? { id: 3, name: input.name.trim() } : { ok: true }); });
    expect(completed).toHaveBeenCalledTimes(1); expect(hook.result.current.busy).toBe(false); expect(locked).toHaveBeenLastCalledWith(false);
    const body = vi.mocked(jsonFetch).mock.calls[input.kind === "create" ? 1 : 0]![1]!.body;
    expect(body ? JSON.parse(String(body)) : undefined).toEqual(input.kind === "move" ? { category_id: 1 } : input.kind === "delete" ? undefined : { name: input.name.trim() });
  });

  it.each([null, {}, { id: 0, name: "新分类" }, { id: 3, name: "串名称" }, { id: "3", name: "新分类" }])("创建坏回包 %j 只读按唯一名称核对，不重复 POST", async response => {
    vi.mocked(jsonFetch).mockResolvedValueOnce([]).mockResolvedValueOnce(response).mockResolvedValueOnce([{ id: 4, name: "新分类", entry_count: 0 }]);
    const completed = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed));
    await act(() => hook.result.current.run({ kind: "create", name: "新分类" }));
    expect(completed).toHaveBeenCalledExactlyOnceWith({ kind: "create", name: "新分类" }, { id: 4, name: "新分类", entry_count: 0 });
    expect(hook.result.current.notice).toContain("只读核对"); expect(vi.mocked(jsonFetch).mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
  });

  it("既有同名分类在创建回包丢失后不能被认作本次创建", async () => {
    const existing = { id: 4, name: "新分类", entry_count: 1 };
    vi.mocked(jsonFetch).mockResolvedValueOnce([existing]).mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce([existing]);
    const completed = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed));
    await act(() => hook.result.current.run({ kind: "create", name: "新分类" }));
    expect(completed).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain("尚未符合本次操作");
    expect(vi.mocked(jsonFetch).mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
  });

  it.each(inputs.slice(1))("%j 坏确认、503 和串记录保持未知锁，重读只发 GET", async input => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: "true" }).mockRejectedValueOnce(new HttpError("合成读取失败", 503));
    const completed = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed));
    await act(() => hook.result.current.run(input)); expect(hook.result.current.phase).toBe("unknown"); expect(completed).not.toHaveBeenCalled();
    await act(() => hook.result.current.run({ kind: "create", name: "不允许抢跑" })); expect(jsonFetch).toHaveBeenCalledTimes(2);
    vi.mocked(jsonFetch).mockResolvedValueOnce(input.kind === "move" ? { ...snapshot, id: 8 } : { ...category, id: 9 });
    await act(async () => { hook.result.current.reread(); }); expect(hook.result.current.phase).toBe("unknown");
    if (input.kind === "delete") vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("分类不存在", 404));
    else vi.mocked(jsonFetch).mockResolvedValueOnce(input.kind === "move" ? snapshot : category);
    await act(async () => { hook.result.current.reread(); hook.result.current.reread(); });
    expect(hook.result.current.phase).toBe("idle"); expect(completed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(jsonFetch).mock.calls.slice(1).every(([, init]) => !init?.method && init?.cache === "no-store")).toBe(true);
  });

  it.each([400, 401, 404, 409, 422])("确定的 %s 错误保留原稿且不自动 GET 或重写", async status => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("业务拒绝", status)); const completed = vi.fn();
    const hook = renderHook(() => useNotebookCategoryCommand(completed)); await act(() => hook.result.current.run(inputs[1]!));
    expect(completed).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledTimes(1); expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.error).toBe("业务拒绝");
  });

  it.each([new Error("网络中断"), new HttpError("超时", 408), new HttpError("异常", 500)])("不确定错误 %j 只读回读目标分类", async reason => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(reason).mockResolvedValueOnce(category); const completed = vi.fn();
    const hook = renderHook(() => useNotebookCategoryCommand(completed)); await act(() => hook.result.current.run(inputs[1]!)); expect(completed).toHaveBeenCalledTimes(1);
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/notebook/categories/1", expect.objectContaining({ cache: "no-store" }));
  });

  it("有效回读不匹配时保留原稿并说明仍可能迟到完成，不能伪装成功", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce({ ...snapshot, category_id: null });
    const completed = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed)); await act(() => hook.result.current.run(inputs[2]!));
    expect(completed).not.toHaveBeenCalled(); expect(hook.result.current.error).toContain("稍后完成"); expect(hook.result.current.phase).toBe("idle");
  });

  it("创建后目录端点 404 不能证明目标名称不存在，继续保持未知锁", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce([]).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("目录读取异常", 404));
    const completed = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed));
    await act(() => hook.result.current.run({ kind: "create", name: "新分类" })); expect(hook.result.current.phase).toBe("unknown"); expect(completed).not.toHaveBeenCalled();
  });

  it("取消删除从确认开始互斥，零写入且不回调", async () => {
    const pending = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise);
    const completed = vi.fn(); const hook = renderHook(() => useNotebookCategoryCommand(completed));
    await act(async () => { void hook.result.current.run(inputs[3]!); void hook.result.current.run(inputs[3]!); });
    expect(confirmDialog).toHaveBeenCalledTimes(1); expect(hook.result.current.phase).toBe("confirming");
    expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain("复习历史和求职准备关联继续保留");
    await act(async () => { pending.resolve(false); }); expect(jsonFetch).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled(); expect(hook.result.current.busy).toBe(false);
  });

  it("离页取消等待，迟到成功不污染新会话", async () => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const oldCompleted = vi.fn(); const old = renderHook(() => useNotebookCategoryCommand(oldCompleted));
    await act(async () => { void old.result.current.run(inputs[1]!); }); const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!;
    old.unmount(); expect(signal.aborted).toBe(true); const latestCompleted = vi.fn(); const latest = renderHook(() => useNotebookCategoryCommand(latestCompleted));
    await act(async () => { pending.resolve({ ok: true }); }); expect(oldCompleted).not.toHaveBeenCalled(); expect(latestCompleted).not.toHaveBeenCalled(); expect(latest.result.current.phase).toBe("idle");
  });
});
