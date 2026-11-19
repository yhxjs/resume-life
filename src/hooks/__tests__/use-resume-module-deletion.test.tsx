// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { getResumeSaveQueue, ResumeSaveQueue, type ResumeDocument } from "@/lib/resume-save-queue";
import { useResumeEditorController } from "../use-resume-editor-controller";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", async original => ({ ...await original<typeof import("@/lib/resume-save-queue")>(), getResumeSaveQueue: vi.fn() }));

type EditorDocument = ResumeDocument & { resume: { id: number; template: string; created_at: string; updated_at: string } };
const document = (id: string) => ({
  resume: { id: Number(id), title: `简历 ${id}`, template: "classic", created_at: "", updated_at: "" },
  modules: [
    { key: "basic", type: "basic", label: "基本信息", sort: 0, content: { name: `姓名 ${id}` } },
    { key: "summary", type: "summary", label: "个人简介", sort: 1, content: { text: "保留原稿" } },
    { key: "work", type: "work", label: "工作经历", sort: 2, content: [] },
  ],
} satisfies EditorDocument);
function setup(id = "1") {
  const server: ResumeDocument = document(id); let stored = "";
  let beforePatch = async (_body: Record<string, unknown>) => { void _body; };
  const patch = vi.fn(async (body: Record<string, unknown>) => {
    await beforePatch(body);
    if (body.modules) server.modules = server.modules.map(module => module.key in (body.modules as object)
      ? { ...module, content: (body.modules as Record<string, unknown>)[module.key] } : module);
    if (typeof body.removeModule === "string") server.modules = server.modules.filter(module => module.key !== body.removeModule);
    return structuredClone(server);
  });
  const queue = new ResumeSaveQueue(patch, { read: () => stored, write: value => { stored = value; } });
  return { queue, patch, read: () => structuredClone(server), before: (callback: typeof beforePatch) => { beforePatch = callback; } };
}
const sessions = new Map<string, ReturnType<typeof setup>>();
beforeEach(() => {
  vi.mocked(getResumeSaveQueue).mockImplementation(id => {
    if (!sessions.has(id)) sessions.set(id, setup(id));
    return sessions.get(id)!.queue;
  });
  vi.mocked(jsonFetch).mockImplementation(async url => url === "/api/templates" ? { items: [] } as never
    : sessions.get(url.split("/").at(-1)!)!.read() as never);
});
afterEach(() => { cleanup(); for (const session of sessions.values()) session.queue.disposeAutoWork(); sessions.clear(); vi.resetAllMocks(); });
async function editor(id = "1") {
  const hook = renderHook(() => useResumeEditorController(id));
  await waitFor(() => expect(hook.result.current.modules).toHaveLength(3));
  return hook;
}

describe("简历模块删除确认和保存队列", () => {
  it("确认阶段离页关闭旧框并结算，不向仍可后台保存的队列新增删除", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); const settled = vi.fn();
    act(() => { void hook.result.current.removeModule("summary").then(settled); });
    expect(screen.getByRole("dialog", { name: "删除模块" }).textContent).toContain("个人简介");
    hook.unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(sessions.get("1")!.patch).not.toHaveBeenCalled(); expect(sessions.get("1")!.read().modules).toHaveLength(3);
  });

  it("离页移除排队确认，其他确认保留且后续没有幽灵删除", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); const settled = vi.fn();
    act(() => {
      void confirmDialog({ title: "其他操作", message: "其他正文" });
      void hook.result.current.removeModule("summary").then(settled);
    });
    hook.unmount();
    expect(screen.getByRole("dialog").textContent).toContain("其他正文");
    await waitFor(() => expect(settled).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(sessions.get("1")!.patch).not.toHaveBeenCalled();
  });

  it("点击确认的同一事件内离页，尚未加入队列的删除不再发送", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); let operation!: Promise<void>;
    act(() => { operation = hook.result.current.removeModule("summary"); });
    act(() => { fireEvent.click(screen.getByRole("button", { name: "删除" })); hook.unmount(); });
    await act(() => operation);
    expect(sessions.get("1")!.patch).not.toHaveBeenCalled(); expect(sessions.get("1")!.read().modules).toHaveLength(3);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("同一事件多次删除只有一个确认和一次写入，旧入口不能再删除已移除模块", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); const oldRemove = hook.result.current.removeModule;
    const operations: Promise<void>[] = [];
    act(() => { operations.push(oldRemove("summary"), oldRemove("summary"), oldRemove("work")); });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(hook.result.current.modules).toHaveLength(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { await Promise.all(operations); await oldRemove("summary"); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(sessions.get("1")!.patch).toHaveBeenCalledTimes(1);
    expect(sessions.get("1")!.read().modules.map(module => module.key)).toEqual(["basic", "work"]);
  });

  it("取消后释放锁，重新确认可删除另一模块且正确选择后继", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); let operation!: Promise<void>;
    act(() => { operation = hook.result.current.removeModule("summary"); });
    fireEvent.click(screen.getByRole("button", { name: "取消" })); await act(() => operation);
    expect(sessions.get("1")!.patch).not.toHaveBeenCalled();
    act(() => { hook.result.current.setActiveKey("work"); });
    act(() => { operation = hook.result.current.removeModule("work"); });
    fireEvent.click(screen.getByRole("button", { name: "删除" })); await act(() => operation);
    expect(hook.result.current.activeKey).toBe("summary"); expect(sessions.get("1")!.patch).toHaveBeenCalledTimes(1);
  });

  it("删除等待期间新选择的模块不被旧选择覆盖", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); const pending = Promise.withResolvers<void>();
    sessions.get("1")!.before(() => pending.promise); let operation!: Promise<void>;
    act(() => { hook.result.current.setActiveKey("summary"); });
    act(() => { operation = hook.result.current.removeModule("summary"); });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(sessions.get("1")!.patch).toHaveBeenCalledOnce());
    act(() => { hook.result.current.setActiveKey("basic"); });
    await act(async () => { pending.resolve(); await operation; });
    expect(hook.result.current.activeKey).toBe("basic"); expect(hook.result.current.modules).toHaveLength(2);
  });

  it("卸载后保留的删除回调不能重新弹框或新增写入", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); const remove = hook.result.current.removeModule;
    hook.unmount();
    act(() => { void remove("summary"); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(sessions.get("1")!.patch).not.toHaveBeenCalled();
  });

  it("已确认的删除继续排空其他模块原稿，离页不取消共享队列或改写新编辑器", async () => {
    render(<ConfirmDialogHost />); const old = await editor(); const pending = Promise.withResolvers<void>();
    const first = sessions.get("1")!; first.before(async body => { if (body.removeModule) await pending.promise; });
    act(() => { old.result.current.setDraft("basic", { name: "离页前必须保存" }); });
    let operation!: Promise<void>; act(() => { operation = old.result.current.removeModule("summary"); });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(first.patch).toHaveBeenCalledTimes(2));
    old.unmount(); const next = await editor("2");
    await act(async () => { pending.resolve(); await operation; });
    expect(first.read().modules.map(module => module.key)).toEqual(["basic", "work"]);
    expect(first.read().modules[0]!.content).toEqual({ name: "离页前必须保存" });
    expect(next.result.current.modules).toEqual(document("2").modules); expect(sessions.get("2")!.patch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("删除失败保留模块并释放锁，离页后的迟到失败不展示旧提示", async () => {
    render(<ConfirmDialogHost />); const hook = await editor(); const session = sessions.get("1")!;
    session.before(async () => { throw new Error("本次删除失败"); }); let operation!: Promise<void>;
    act(() => { operation = hook.result.current.removeModule("summary"); });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const alert = await screen.findByRole("dialog", { name: "删除模块失败" });
    expect(alert.textContent).toContain("本次删除失败"); expect(hook.result.current.modules).toHaveLength(3);
    fireEvent.click(within(alert).getByRole("button", { name: "确定" }));
    await act(() => operation);
    const pending = Promise.withResolvers<void>(); session.before(() => pending.promise);
    act(() => { operation = hook.result.current.removeModule("summary"); });
    fireEvent.click(screen.getByRole("button", { name: "删除" })); await waitFor(() => expect(session.patch).toHaveBeenCalledTimes(2));
    hook.unmount();
    await act(async () => { pending.reject(new Error("迟到失败")); await operation; });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("失败提示已展示时离页也关闭本项，保留后续其他操作", async () => {
    render(<ConfirmDialogHost />); const hook = await editor();
    sessions.get("1")!.before(async () => { throw new Error("模块删除被拒绝"); });
    let operation!: Promise<void>; act(() => { operation = hook.result.current.removeModule("summary"); });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await screen.findByRole("dialog", { name: "删除模块失败" });
    act(() => { void confirmDialog({ title: "下一操作", message: "下一项正文" }); });
    hook.unmount();
    expect(screen.getByRole("dialog", { name: "下一操作" }).textContent).toContain("下一项正文");
    await act(() => operation);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
