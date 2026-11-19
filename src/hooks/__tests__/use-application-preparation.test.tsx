// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useApplicationPreparation } from "../use-application-preparation";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";
import type { ApplicationPreparation, PreparationTask } from "@/lib/application-preparation-types";

vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));

const base = "/api/applications/8/preparation";
const task: PreparationTask = { id: 1, title: "核对接口维护范围 Array<T> &amp;", done: false, due_time: "", created_at: "2026-10-28T00:00:00.000Z" };
function preparation(): ApplicationPreparation {
  const emptyPage = () => ({ items: [], nextCursor: null, total: 0 });
  return {
    application: { id: 8, company: "甲公司", role: "接口开发", stage: "applied", resume_id: 4, resume_version_id: 41, jd: "接口开发岗位" } as ApplicationPreparation["application"],
    tasks: [{ ...task }],
    resources: { diagnosis: emptyPage(), intro: emptyPage(), portrait: emptyPage(), interview: emptyPage(), series: emptyPage(), notebook: emptyPage() },
  };
}
async function setup(initial = preparation()) {
  vi.mocked(jsonFetch).mockResolvedValueOnce(initial);
  const hook = renderHook(() => useApplicationPreparation("8"));
  await waitFor(() => expect(hook.result.current.data).toEqual(initial));
  return hook;
}
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); vi.mocked(fetchSse).mockReset(); });
afterEach(cleanup);

it("添加已确认但刷新失败时保留服务端待办，重试只读取资料，不重复创建", async () => {
  const hook = await setup();
  const saved = { ...task, id: 2, title: "已保存的新待办", due_time: "2026-10-29T03:00:00.000Z" };
  vi.mocked(jsonFetch).mockResolvedValueOnce(saved).mockRejectedValueOnce(new Error("刷新失败"));
  let succeeded: boolean | undefined;
  await act(async () => { succeeded = await hook.result.current.mutate("tasks", "POST", { title: saved.title, due_time: saved.due_time }, "添加待办"); });
  expect(succeeded).toBe(true);
  expect(hook.result.current.data!.tasks).toEqual([saved, task]);
  expect(hook.result.current.notice).toBe("添加待办成功");
  expect(hook.result.current.error).toContain("刷新失败");
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...preparation(), tasks: [saved, task] });
  await act(async () => { await hook.result.current.reload(); });
  expect(hook.result.current.error).toBe("");
  expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toBe(base);
});

it("删除已确认但刷新失败时移除原待办，不再提供重复删除入口", async () => {
  const hook = await setup();
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("刷新失败"));
  await act(async () => { await hook.result.current.mutate("tasks", "DELETE", { id: task.id }, "删除待办"); });
  expect(hook.result.current.data!.tasks).toEqual([]);
  expect(hook.result.current.notice).toBe("删除待办成功");
  expect(hook.result.current.error).toContain("刷新失败");
});

it("开始保存时取消早先的资料刷新，旧响应不能撤销当前乐观勾选", async () => {
  const hook = await setup();
  const oldRead = Promise.withResolvers<ApplicationPreparation>();
  const write = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(write.promise).mockResolvedValueOnce({ ...preparation(), tasks: [{ ...task, done: true }] });
  let reading!: Promise<unknown>;
  let writing!: Promise<unknown>;
  act(() => { reading = hook.result.current.reload(); });
  const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]?.signal;
  act(() => { writing = hook.result.current.toggleTask(task.id, true); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { oldRead.resolve(preparation()); await reading; });
  expect(hook.result.current.data!.tasks[0]!.done).toBe(true);
  await act(async () => { write.resolve({ ok: true }); await writing; });
  expect(hook.result.current.data!.tasks[0]!.done).toBe(true);
});

it("刷新首页使在途分页失效，旧下一页不能混入新列表", async () => {
  const initial = preparation();
  initial.resources.notebook = { items: [{ id: 8, title: "旧首页", summary: "", resume_id: null, href: null, created_at: "", linked: true }], nextCursor: "8", total: 2 };
  const hook = await setup(initial);
  const page = Promise.withResolvers<unknown>();
  const fresh = preparation();
  fresh.resources.notebook = { items: [{ ...initial.resources.notebook.items[0]!, id: 9, title: "新首页" }], nextCursor: null, total: 1 };
  vi.mocked(jsonFetch).mockReturnValueOnce(page.promise).mockResolvedValueOnce(fresh);
  let paging!: Promise<unknown>;
  act(() => { paging = hook.result.current.loadMore("notebook"); });
  const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]?.signal;
  await act(async () => { await hook.result.current.reload(); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { page.resolve({ items: [{ ...initial.resources.notebook.items[0]!, id: 1, title: "已取消关联的旧下一页" }], nextCursor: null, total: 2 }); await paging; });
  expect(hook.result.current.data!.resources.notebook).toEqual(fresh.resources.notebook);
  expect(hook.result.current.notice).not.toBe("加载错题成功");
});

it("更新已确认但刷新失败时采用规范化字段并维持未完成优先的顺序", async () => {
  const initial = preparation();
  initial.tasks.push({ ...task, id: 2, title: "仍未完成" });
  const hook = await setup(initial);
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("读取不可用"));
  await act(async () => { await hook.result.current.mutate("tasks", "PATCH", {
    id: task.id, title: "  新标题 Array<T> &amp;  ", done: true, due_time: "  2026-10-29T11:00:00+08:00  ",
  }, "更新待办"); });
  expect(hook.result.current.data!.tasks).toEqual([initial.tasks[1], {
    ...task, title: "新标题 Array<T> &amp;", done: true, due_time: "2026-10-29T03:00:00.000Z",
  }]);
  expect(hook.result.current.notice).toBe("更新待办成功");
  expect(hook.result.current.error).toContain("读取不可用");
});

it("关联写入采用同事务返回的完整快照，不再追加可能失败的旧数据读取", async () => {
  const hook = await setup();
  const snapshot = preparation();
  snapshot.resources.portrait = {
    items: [{ id: 9, title: "新关联画像", summary: "已确认", resume_id: null, href: "/tools/jd/9", created_at: "", linked: true }],
    nextCursor: null,
    total: 1,
  };
  snapshot.resources.notebook = {
    items: [{ id: 3, title: "随模拟面试归属的错题", summary: "保留快照", resume_id: null, href: null, created_at: "", linked: false }],
    nextCursor: null,
    total: 1,
  };
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, preparation: snapshot });
  await act(async () => {
    expect(await hook.result.current.mutate("resources", "POST", { kind: "portrait", id: 9 }, "关联资料")).toBe(true);
  });
  expect(hook.result.current.data).toEqual(snapshot);
  expect(hook.result.current.notice).toBe("关联资料成功");
  expect(hook.result.current.error).toBe("");
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toBe(`${base}/resources`);
});

it("取消关联应用服务端确认的整页状态，包括仍由模拟面试归属的错题", async () => {
  const initial = preparation();
  initial.resources.interview = {
    items: [{ id: 6, title: "本次模拟面试", summary: "", resume_id: 4, href: "/interviews/6", created_at: "", linked: true }],
    nextCursor: null,
    total: 1,
  };
  const hook = await setup(initial);
  const snapshot = preparation();
  snapshot.resources.notebook = {
    items: [{ id: 3, title: "源面试已取消，错题仍保留", summary: "来自该面试", resume_id: null, href: null, created_at: "", linked: false }],
    nextCursor: null,
    total: 1,
  };
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, preparation: snapshot });
  await act(async () => {
    expect(await hook.result.current.mutate("resources", "DELETE", { kind: "interview", id: 6 }, "取消关联")).toBe(true);
  });
  expect(hook.result.current.data).toEqual(snapshot);
  expect(hook.result.current.data!.resources.interview).toMatchObject({ items: [], total: 0 });
  expect(hook.result.current.data!.resources.notebook.items[0]?.title).toContain("仍保留");
});

it("勾选成功而刷新失败时不回滚，真正写入失败时才恢复原勾选", async () => {
  const hook = await setup();
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("刷新失败"));
  await act(async () => { await hook.result.current.toggleTask(task.id, true); });
  expect(hook.result.current.data!.tasks[0]!.done).toBe(true);
  vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("写入失败", 400));
  await act(async () => { await hook.result.current.toggleTask(task.id, false); });
  expect(hook.result.current.data!.tasks[0]!.done).toBe(true);
  expect(hook.result.current.error).toBe("写入失败");
  expect(hook.result.current.notice).toBe("");
});

it.each(["POST", "PATCH", "DELETE"] as const)("%s 写入失败不修改已确认列表，也不刷新或误报成功", async (method) => {
  const hook = await setup();
  vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("写入被拒绝", 400));
  let succeeded: boolean | undefined;
  await act(async () => { succeeded = await hook.result.current.mutate("tasks", method, { id: 1, title: "新标题", done: true }, "修改待办"); });
  expect(succeeded).toBe(false);
  expect(hook.result.current.data).toEqual(preparation());
  expect(hook.result.current.error).toBe("写入被拒绝");
  expect(hook.result.current.notice).toBe("");
  expect(hook.result.current.busy).toBe("");
  expect(jsonFetch).toHaveBeenCalledTimes(2);
});

it("写入期间不另读旧快照，提交确认后仍刷新完整资料", async () => {
  const hook = await setup();
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...preparation(), tasks: [{ ...task, done: true }] });
  let writing!: Promise<unknown>;
  act(() => { writing = hook.result.current.toggleTask(task.id, true); });
  await act(async () => { expect(await hook.result.current.reload()).toBe(false); });
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect(hook.result.current.data!.tasks[0]!.done).toBe(true);
  await act(async () => { pending.resolve({ ok: true }); await writing; });
  expect(jsonFetch).toHaveBeenCalledTimes(3);
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[0]).toBe(base);
  expect(hook.result.current.notice).toBe("更新待办成功");
});

it("写入失败也执行等待中的刷新，保留最新服务端状态和原写入错误", async () => {
  const hook = await setup();
  const pending = Promise.withResolvers<unknown>();
  const latest = { ...preparation(), tasks: [{ ...task, title: "其他页面已更新", done: true }] };
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(latest);
  let writing!: Promise<unknown>;
  act(() => { writing = hook.result.current.toggleTask(task.id, true); });
  await act(async () => { await hook.result.current.reload(); });
  await act(async () => { pending.reject(new HttpError("本次写入失败", 400)); await writing; });
  expect(hook.result.current.data).toEqual(latest);
  expect(hook.result.current.error).toBe("本次写入失败");
  expect(hook.result.current.busy).toBe("");
  expect(jsonFetch).toHaveBeenCalledTimes(3);
});

it.each(["成功", "失败"])("被新刷新替换的旧读取晚到%s时不能覆盖当前快照或错误", async (outcome) => {
  const hook = await setup();
  const old = Promise.withResolvers<ApplicationPreparation>();
  const fresh = { ...preparation(), tasks: [{ ...task, title: "当前读取的内容" }] };
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(fresh);
  let reading!: Promise<unknown>;
  act(() => { reading = hook.result.current.reload(); });
  const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]?.signal;
  await act(async () => { await hook.result.current.reload(); });
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    if (outcome === "成功") old.resolve(preparation());
    else old.reject(new Error("旧读取失败"));
    await reading;
  });
  expect(hook.result.current.data).toEqual(fresh);
  expect(hook.result.current.error).toBe("");
});

it.each(["写入等待", "刷新等待"])("卸载发生在%s时取消所属请求，不返回可触发关闭的成功", async (phase) => {
  const hook = await setup();
  const pending = Promise.withResolvers<unknown>();
  if (phase === "写入等待") vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  else vi.mocked(jsonFetch).mockResolvedValueOnce({ ...task, id: 2 }).mockReturnValueOnce(pending.promise);
  let writing!: Promise<boolean>;
  act(() => { writing = hook.result.current.mutate("tasks", "POST", { title: task.title }, "添加待办"); });
  const expectedCalls = phase === "写入等待" ? 2 : 3;
  await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(expectedCalls));
  const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]?.signal;
  const retained = hook.result.current;
  hook.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(phase === "写入等待" ? { ...task, id: 2 } : preparation()); expect(await writing).toBe(false); });
  expect(jsonFetch).toHaveBeenCalledTimes(expectedCalls);
  await retained.reload();
  await retained.generate("portrait");
  await retained.toggleTask(task.id, true);
  expect(await retained.mutate("tasks", "DELETE", { id: task.id }, "删除待办")).toBe(false);
  expect(jsonFetch).toHaveBeenCalledTimes(expectedCalls);
});

it.each(["成功", "失败"])("取消旧分页后可立即保存，分页晚到%s不解除新操作的忙碌状态", async (outcome) => {
  const initial = preparation();
  initial.resources.notebook.items = [{ id: 8, title: "已有错题", summary: "", resume_id: null, href: null, created_at: "", linked: true }];
  initial.resources.notebook.total = 2;
  initial.resources.notebook.nextCursor = "8";
  const hook = await setup(initial);
  const old = Promise.withResolvers<unknown>();
  const write = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(initial).mockReturnValueOnce(write.promise).mockResolvedValueOnce({ ...initial, tasks: [] });
  let paging!: Promise<unknown>;
  let writing!: Promise<unknown>;
  act(() => { paging = hook.result.current.loadMore("notebook"); });
  await act(async () => { await hook.result.current.reload(); });
  act(() => { writing = hook.result.current.mutate("tasks", "DELETE", { id: task.id }, "删除待办"); });
  await act(async () => {
    if (outcome === "成功") old.resolve({ items: [], nextCursor: null, total: 0 });
    else old.reject(new Error("旧分页失败"));
    await paging;
  });
  expect(hook.result.current.busy).toBe("删除待办");
  expect(hook.result.current.notice).toBe("");
  expect(hook.result.current.error).toBe("");
  await act(async () => { write.resolve({ ok: true }); await writing; });
  expect(hook.result.current.busy).toBe("");
  expect(hook.result.current.notice).toBe("删除待办成功");
});

it("下一页失败可使用相同游标重试，不丢首页、不重复追加", async () => {
  const initial = preparation();
  const first = { id: 8, title: "首页记录", summary: "", resume_id: null, href: null, created_at: "", linked: true };
  initial.resources.notebook = { items: [first], nextCursor: "8", total: 2 };
  const hook = await setup(initial);
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("下一页失败")).mockResolvedValueOnce({ items: [{ ...first, id: 1, title: "下一页记录" }], nextCursor: null, total: 2 });
  await act(async () => { await hook.result.current.loadMore("notebook"); });
  expect(hook.result.current.data!.resources.notebook).toEqual(initial.resources.notebook);
  expect(hook.result.current.error).toBe("下一页失败");
  await act(async () => { await hook.result.current.loadMore("notebook"); });
  expect(hook.result.current.data!.resources.notebook.items.map((item) => item.id)).toEqual([8, 1]);
  expect(vi.mocked(jsonFetch).mock.calls.slice(-2).map(([url]) => url)).toEqual(Array(2).fill(`${base}/resources?kind=notebook&limit=5&cursor=8`));
  expect(hook.result.current.error).toBe("");
});
