// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useApplicationPreparation } from "../use-application-preparation";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { ApplicationPreparation, PreparationResource, PreparationTask } from "@/lib/application-preparation-types";

vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
const task: PreparationTask = { id: 1, title: "已有待办", done: false, due_time: "", created_at: "2026-11-03T01:02:03.000Z" };
const entry: PreparationResource = { id: 8, title: "原始资料 <T> &amp;", summary: "尚未上线", resume_id: null, href: null, linked: true, created_at: "" };
function snapshot(): ApplicationPreparation {
  const page = () => ({ items: [], nextCursor: null, total: 0 });
  return { application: { id: 8, company: "甲公司", role: "接口开发", jd: "岗位 JD", resume_id: null, stage: "applied" } as ApplicationPreparation["application"], tasks: [structuredClone(task)],
    resources: { diagnosis: page(), intro: page(), portrait: page(), interview: page(), series: page(), notebook: { items: [structuredClone(entry)], nextCursor: "8", total: 2 } } };
}
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); }); afterEach(cleanup);
async function setup() { vi.mocked(jsonFetch).mockResolvedValueOnce(snapshot()); const hook = renderHook(() => useApplicationPreparation("8")); await waitFor(() => expect(hook.result.current.data).toEqual(snapshot())); return hook; }
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method);
const defects = [
  { label: "串投递", change: (value: ApplicationPreparation) => { value.application.id = 9; } },
  { label: "缺少JD", change: (value: ApplicationPreparation) => { delete (value.application as Partial<typeof value.application>).jd; } },
  { label: "非法阶段", change: (value: ApplicationPreparation) => { Object.assign(value.application, { stage: "invalid" }); } },
  { label: "缺少资料类型", change: (value: ApplicationPreparation) => { delete (value.resources as Partial<typeof value.resources>).notebook; } },
  { label: "重复待办ID", change: (value: ApplicationPreparation) => { value.tasks.push({ ...task }); } },
  { label: "待办布尔值错误", change: (value: ApplicationPreparation) => { Object.assign(value.tasks[0]!, { done: "false" }); } },
  { label: "资料正文残缺", change: (value: ApplicationPreparation) => { delete (value.resources.notebook.items[0] as Partial<PreparationResource>).summary; } },
  { label: "资料ID非法", change: (value: ApplicationPreparation) => { value.resources.notebook.items[0]!.id = -1; } },
  { label: "资料游标缺失", change: (value: ApplicationPreparation) => { delete (value.resources.notebook as Partial<typeof value.resources.notebook>).nextCursor; } },
  { label: "重复资料ID", change: (value: ApplicationPreparation) => { value.resources.notebook.items.push({ ...entry }); } },
  { label: "轮次串投递", change: (value: ApplicationPreparation) => { value.application.interviews = [{ id: 3, application_id: 9, round_name: "一面", status: "scheduled", notes: "", interview_time: "", interviewer: "", created_at: "", updated_at: "" }]; } },
];
it.each(defects)("初次读取 $label 不展示错误投递或崩溃，保留只读重试", async ({ change }) => {
  const bad = snapshot(); change(bad); vi.mocked(jsonFetch).mockResolvedValueOnce(bad);
  const hook = renderHook(() => useApplicationPreparation("8")); await waitFor(() => expect(hook.result.current.error).not.toBe(""));
  expect(hook.result.current.data).toBeNull(); expect(writes()).toHaveLength(0);
  vi.mocked(jsonFetch).mockResolvedValueOnce(snapshot()); await act(async () => { expect(await hook.result.current.reload()).toBe(true); }); expect(hook.result.current.data).toEqual(snapshot());
});
it.each(defects)("关联写入 $label 回包不替换原快照或报成功，刷新核对后才解锁", async ({ change }) => {
  const hook = await setup(); const bad = snapshot(); change(bad); vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, preparation: bad });
  await act(async () => { expect(await hook.result.current.mutate("resources", "POST", { kind: "notebook", id: 3 }, "关联资料")).toBe(false); });
  expect(hook.result.current.data).toEqual(snapshot()); expect(hook.result.current.notice).toBe(""); expect(hook.result.current.error).toContain("先刷新资料核对");
  await act(async () => { expect(await hook.result.current.mutate("tasks", "DELETE", { id: 1 }, "删除待办")).toBe(false); }); expect(writes()).toHaveLength(1);
  vi.mocked(jsonFetch).mockResolvedValueOnce(snapshot()); await act(async () => { await hook.result.current.reload(); }); expect(hook.result.current.error).toBe("");
});
it.each([{}, { ok: false }, { ok: "true" }])("关联回包 %j 不视为成功，即使快照完整", async receipt => {
  const hook = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce({ ...receipt, preparation: snapshot() });
  await act(async () => { expect(await hook.result.current.mutate("resources", "DELETE", { kind: "notebook", id: 8 }, "取消关联")).toBe(false); }); expect(hook.result.current.data).toEqual(snapshot()); expect(hook.result.current.notice).toBe("");
});
const badTasks = [
  {}, { ...task, id: 0 }, { ...task, id: 1 }, { ...task, id: 2, title: "串标题" }, { ...task, id: 2, done: true },
  { ...task, id: 2, due_time: "2099-11-03T00:00:00.000Z" }, { id: 2, title: "新待办", done: false, due_time: "" },
];
it.each(badTasks)("添加待办回包 %j 不清空草稿或插入伪记录，保留未知锁", async bad => {
  const hook = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce(bad);
  await act(async () => { expect(await hook.result.current.mutate("tasks", "POST", { title: "新待办" }, "添加待办")).toBe(false); });
  expect(hook.result.current.data).toEqual(snapshot()); expect(hook.result.current.notice).toBe(""); expect(hook.result.current.error).toContain("先刷新资料核对");
  await act(async () => { await hook.result.current.mutate("tasks", "POST", { title: "新待办" }, "添加待办"); }); expect(writes()).toHaveLength(1);
});
it.each(["PATCH", "DELETE"] as const)("%s 待办坏确认不能修改列表或误报成功，未知状态勾选也不能变化", async method => {
  const hook = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false });
  await act(async () => { expect(await hook.result.current.mutate("tasks", method, { id: 1, done: true }, "修改待办")).toBe(false); });
  expect(hook.result.current.data!.tasks).toEqual([task]); expect(hook.result.current.notice).toBe("");
  await act(async () => { await hook.result.current.toggleTask(1, true); }); expect(hook.result.current.data!.tasks).toEqual([task]); expect(writes()).toHaveLength(1);
});
it.each([new Error("网络中断"), new HttpError("超时", 408), new HttpError("服务器异常", 503)])("可能已写入的异常 %j 保持未知锁，失败／串投递读取不能解锁", async reason => {
  const hook = await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(reason);
  await act(async () => { await hook.result.current.mutate("tasks", "POST", { title: "新待办" }, "添加待办"); });
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("刷新失败")); await act(async () => { expect(await hook.result.current.reload()).toBe(false); });
  const foreign = snapshot(); foreign.application.id = 9; vi.mocked(jsonFetch).mockResolvedValueOnce(foreign); await act(async () => { expect(await hook.result.current.reload()).toBe(false); });
  await act(async () => { await hook.result.current.mutate("tasks", "POST", { title: "新待办" }, "添加待办"); await hook.result.current.generate("portrait"); await hook.result.current.loadMore("notebook"); }); expect(writes()).toHaveLength(1);
  expect(jsonFetch).toHaveBeenCalledTimes(4); expect(hook.result.current.error).toContain("先刷新资料核对");
  vi.mocked(jsonFetch).mockResolvedValueOnce(snapshot()); await act(async () => { expect(await hook.result.current.reload()).toBe(true); });
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ...snapshot(), tasks: [] }); await act(async () => { expect(await hook.result.current.mutate("tasks", "DELETE", { id: 1 }, "删除待办")).toBe(true); }); expect(writes()).toHaveLength(2);
});
it("明确400拒绝不进入未知锁，补齐内容即可继续提交", async () => {
  const hook = await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("内容无效", 400));
  await act(async () => { await hook.result.current.mutate("tasks", "POST", { title: "" }, "添加待办"); }); expect(hook.result.current.error).toBe("内容无效");
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...task, id: 2, title: "补齐内容" }).mockResolvedValueOnce({ ...snapshot(), tasks: [{ ...task, id: 2, title: "补齐内容" }, task] });
  await act(async () => { expect(await hook.result.current.mutate("tasks", "POST", { title: "补齐内容" }, "添加待办")).toBe(true); }); expect(writes()).toHaveLength(2);
});
it.each([{}, { items: [], nextCursor: "8", total: 2 }, { items: [{ ...entry, id: 9 }], nextCursor: null, total: 2 }, { items: [{ ...entry, id: 1 }, { ...entry, id: 1 }], nextCursor: null, total: 2 }])("坏下一页 %j 不推进游标或污染资料，显式重试同一游标", async bad => {
  const hook = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce(bad); await act(async () => { await hook.result.current.loadMore("notebook"); });
  expect(hook.result.current.data).toEqual(snapshot()); expect(hook.result.current.notice).toBe(""); expect(hook.result.current.error).not.toBe("");
  vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [{ ...entry, id: 1 }], nextCursor: null, total: 2 }); await act(async () => { await hook.result.current.loadMore("notebook"); });
  expect(hook.result.current.data!.resources.notebook.items.map(item => item.id)).toEqual([8, 1]); expect(vi.mocked(jsonFetch).mock.calls.slice(-2).map(([url]) => url)).toEqual(Array(2).fill("/api/applications/8/preparation/resources?kind=notebook&limit=5&cursor=8"));
});
