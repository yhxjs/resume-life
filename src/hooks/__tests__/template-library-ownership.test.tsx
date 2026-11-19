// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { BUILTIN_STYLES, type CustomTemplate } from "@/lib/templates";
import { useTemplateLibrary } from "../use-template-library";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const a: CustomTemplate = { id: 7, name: "历史模板 <T> &amp; ".repeat(12), style: BUILTIN_STYLES.modern, created_at: "原始时间", updated_at: "修改时间" };
const b = { ...a, id: 8, name: "另一模板", style: BUILTIN_STYLES.classic };
const broken = { ...a, corrupted: true };
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method);
beforeEach(() => { vi.mocked(jsonFetch).mockReset().mockResolvedValue({ items: [a, b] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup() {
  render(<ConfirmDialogHost />);
  const hook = renderHook(() => useTemplateLibrary());
  await waitFor(() => expect(hook.result.current.customs).toHaveLength(2));
  act(() => { hook.result.current.loadStyle(b); hook.result.current.setAiPrompt("待生成"); });
  return hook;
}

describe.each(["delete", "repair"] as const)("模板 %s 确认归属", kind => {
  function start(controller: ReturnType<typeof useTemplateLibrary>) { return kind === "delete" ? controller.removeCustom(a) : controller.loadStyle(broken); }
  it("离页关闭当前确认，旧入口不能写入或再弹确认", async () => {
    const hook = await setup(); const old = hook.result.current;
    act(() => { void start(old); }); expect(screen.getByRole("dialog")).toBeTruthy();
    hook.unmount(); expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { await start(old); }); expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(0);
  });
  it("离页移除排队确认，其他确认正常继续", async () => {
    const hook = await setup(); act(() => { void confirmDialog({ title: "当前有效", message: "其他工作" }); void start(hook.result.current); void confirmDialog({ title: "后续有效", message: "后续工作" }); });
    hook.unmount(); fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("dialog").textContent).toContain("后续有效"); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(writes()).toHaveLength(0);
  });
  it("同事件重复触发只有一次确认，取消后队列为空", async () => {
    const hook = await setup(); act(() => { void start(hook.result.current); void start(hook.result.current); });
    fireEvent.click(screen.getByRole("button", { name: "取消" })); await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(0); expect(hook.result.current.editingId).toBe(b.id);
  });
  it("确认说明固定的模板 ID、完整历史名称及范围", async () => {
    const hook = await setup(); let operation: ReturnType<typeof start>; act(() => { operation = start(hook.result.current); }); const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("#7"); expect(dialog.textContent).toContain(a.name);
    expect(dialog.textContent).toContain(kind === "delete" ? "简历" : "保存修改");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); await operation; });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(0); expect(hook.result.current.editingId).toBe(b.id);
  });
});

describe("模板操作并发与迟到响应", () => {
  it.each(["saveNew", "saveChanges", "aiGenerate"] as const)("%s 等待时不能开始删除或修复，离页中止且不刷新", async action => {
    const hook = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockClear().mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>; act(() => { operation = hook.result.current[action](); void hook.result.current.removeCustom(a); void hook.result.current.loadStyle(broken); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(1);
    const signal = vi.mocked(jsonFetch).mock.calls[0]?.[1]?.signal; hook.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(action === "aiGenerate" ? { style: a.style } : a); await operation; });
    expect(jsonFetch).toHaveBeenCalledTimes(1); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("删除确认占有写入锁，取消后保留草稿且可保存", async () => {
    const hook = await setup(); act(() => { void hook.result.current.removeCustom(a); void hook.result.current.saveNew(); void hook.result.current.saveChanges(); void hook.result.current.aiGenerate(); });
    expect(writes()).toHaveLength(0); fireEvent.click(screen.getByRole("button", { name: "取消" })); await act(async () => {});
    expect(hook.result.current.draft).toEqual(b.style); vi.mocked(jsonFetch).mockResolvedValueOnce(b);
    await act(() => hook.result.current.saveChanges()); expect(writes()).toHaveLength(1);
  });
  it("切换正常模板关闭待修复确认，旧确认不能覆盖新选择", async () => {
    const hook = await setup(); act(() => { void hook.result.current.loadStyle(broken); });
    act(() => hook.result.current.loadStyle(b)); expect(screen.queryByRole("dialog")).toBeNull();
    expect(hook.result.current.editingId).toBe(b.id); expect(writes()).toHaveLength(0);
  });
});

describe("模板删除只读核对", () => {
  async function remove(hook: Awaited<ReturnType<typeof setup>>) {
    let operation!: Promise<void>; act(() => { operation = hook.result.current.removeCustom(a); });
    fireEvent.click(screen.getByRole("button", { name: "删除" })); await act(async () => { await operation; });
  }
  it.each([{}, { ok: false }, new Error("断线"), new HttpError("超时", 408)])("异常完成 %# 后仅完整列表可以证明目标不存在", async value => {
    const hook = await setup(); vi.mocked(jsonFetch).mockClear();
    if (value instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(value); else vi.mocked(jsonFetch).mockResolvedValueOnce(value);
    vi.mocked(jsonFetch).mockResolvedValue({ items: [b] }); await remove(hook);
    expect(writes()).toHaveLength(1); expect(hook.result.current.customs).toEqual([b]); expect(hook.result.current.editingId).toBe(b.id);
    expect(vi.mocked(jsonFetch).mock.calls[1]).toEqual(["/api/templates", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it.each([{ items: [null] }, { items: [a, a] }, {}, new HttpError("列表不存在", 404)])("不可读或残缺列表 %# 保持未知锁，手动重读不重删", async value => {
    const hook = await setup(); vi.mocked(jsonFetch).mockClear().mockResolvedValueOnce({ ok: false });
    if (value instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(value); else vi.mocked(jsonFetch).mockResolvedValueOnce(value);
    await remove(hook); expect(hook.result.current.deletion.phase).toBe("unknown");
    act(() => { void hook.result.current.saveNew(); void hook.result.current.removeCustom(b); }); expect(writes()).toHaveLength(1);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [a, b] }); act(() => { hook.result.current.deletion.retryCheck(); hook.result.current.deletion.retryCheck(); });
    await waitFor(() => expect(hook.result.current.deletion.phase).toBe("idle"));
    expect(hook.result.current.deletion.error).toContain("仍存在"); expect(writes()).toHaveLength(1); expect(hook.result.current.customs).toEqual([a, b]);
  });
  it("严格成功后旧列表不能复活模板，旧对象不能重删或加载", async () => {
    const hook = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValue({ items: [a, b] });
    await remove(hook); expect(hook.result.current.customs).toEqual([b]);
    await act(async () => { await hook.result.current.removeCustom(a); hook.result.current.loadStyle(a); });
    expect(writes()).toHaveLength(1); expect(hook.result.current.editingId).toBe(b.id);
  });
  it.each([400, 403, 409, 422])("明确拒绝 %s 保留列表与草稿，不用列表猜测提交结果", async status => {
    const hook = await setup(); vi.mocked(jsonFetch).mockClear().mockRejectedValueOnce(new HttpError("明确拒绝", status)); await remove(hook);
    expect(hook.result.current.deletion.error).toContain("明确拒绝"); expect(hook.result.current.deletion.canStart()).toBe(true);
    expect(jsonFetch).toHaveBeenCalledTimes(1); expect(hook.result.current.customs).toEqual([a, b]); expect(hook.result.current.draft).toEqual(b.style);
  });
  it.each(["deleting", "checking"])("离页中止 %s，忽略不遵守取消信号的迟到结果", async phase => {
    const hook = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockClear();
    if (phase === "checking") vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false });
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>; act(() => { operation = hook.result.current.removeCustom(a); }); fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "checking" ? 2 : 1));
    const signal = vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal; hook.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(phase === "checking" ? { items: [] } : { ok: true }); await operation; });
    expect(jsonFetch).toHaveBeenCalledTimes(phase === "checking" ? 2 : 1); expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("模板保存确认的完整性", () => {
  it.each([null, {}, { ...a, id: b.id + 1 }, { ...b, style: null }])("不完整或串 ID 的修改响应 %# 不污染列表及编辑绑定", async response => {
    const hook = await setup(); vi.mocked(jsonFetch).mockClear().mockResolvedValueOnce(response);
    let operation!: Promise<void>; act(() => { operation = hook.result.current.saveChanges(); });
    const dialog = await screen.findByRole("dialog", { name: "保存修改失败" }); fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
    await act(async () => { await operation; }); expect(hook.result.current.customs).toEqual([a, b]); expect(hook.result.current.editingId).toBe(b.id); expect(jsonFetch).toHaveBeenCalledTimes(1);
  });
  it.each(["saveNew", "saveChanges", "aiGenerate"] as const)("%s 迟到失败不在下一页面弹提示", async action => {
    const hook = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockClear().mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>; act(() => { operation = hook.result.current[action](); }); hook.unmount();
    await act(async () => { pending.reject(new Error("旧页面失败")); await operation; }); expect(screen.queryByRole("dialog")).toBeNull(); expect(jsonFetch).toHaveBeenCalledTimes(1);
  });
});
