// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonFetch } from "@/lib/fetcher";
import { normalizeSummary } from "@/lib/summary";
import { ProjectMaterialsPanel } from "../project-materials-panel";
import { useProjectDetail, type Material } from "../use-project-detail";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("../directory-picker-dialog", () => ({ DirectoryPickerDialog: () => null }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: vi.fn().mockResolvedValue(undefined), confirmDialog: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const a: Material = { id: 11, title: "材料 A", source: "text", filename: "", created_at: "" };
const b: Material = { ...a, id: 22, title: "材料 B" };
const loadedA: Material = { ...a, content: "A 正文", revision: "a".repeat(64) };
const loadedB: Material = { ...b, content: "B 正文", revision: "b".repeat(64) };
const project = { id: 1, name: "项目", summary: normalizeSummary({}), summary_updated_at: "", materials: [a, b] };

beforeEach(() => vi.mocked(jsonFetch).mockReset().mockResolvedValue(project));
afterEach(cleanup);

async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  return hook;
}

describe("材料分页请求归属", () => {
  it("旧项目删除晚到后不能发起刷新并抢占新项目的读取", async () => {
    const { confirmDialog } = await import("@/components/common/confirm-dialog");
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    const hook = renderHook(({ id }) => useProjectDetail(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    const deletion = deferred<unknown>();
    const projectB = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(deletion.promise).mockReturnValueOnce(projectB.promise).mockResolvedValueOnce(project);
    let removing!: Promise<void>;
    act(() => { removing = hook.result.current.material.removeMaterial(a.id, a.title); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    hook.rerender({ id: "2" });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    await act(async () => { deletion.resolve({}); await removing; });
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { projectB.resolve({ ...project, id: 2, materials: [] }); });
    expect(hook.result.current.data?.id).toBe(2);
  });
  it("同一 tick 双击只发送一次请求且按 ID 去重", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...project, materials_next_cursor: "next" });
    const hook = await setup();
    const page = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(page.promise);
    act(() => { hook.result.current.material.loadMoreMaterials(); hook.result.current.material.loadMoreMaterials(); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(hook.result.current.material.loadingMoreMaterials).toBe(true);
    await act(async () => { page.resolve({ ...project, materials: [b, { ...b, id: 33 }] }); });
    expect(hook.result.current.data?.materials.map((m) => m.id)).toEqual([11, 22, 33]);
    expect(hook.result.current.material.loadingMoreMaterials).toBe(false);
  });
  it("刷新后不追加迟到的旧分页响应", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...project, materials_next_cursor: "next" });
    const hook = await setup();
    const page = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(page.promise).mockResolvedValueOnce({ ...project, materials: [a] });
    act(() => hook.result.current.material.loadMoreMaterials());
    act(() => hook.result.current.retryLoad());
    await waitFor(() => expect(hook.result.current.data?.materials).toEqual([a]));
    await act(async () => { page.resolve({ ...project, materials: [b] }); });
    expect(hook.result.current.data?.materials).toEqual([a]);
  });
  it("切项目后不提交上个项目的分页", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...project, materials_next_cursor: "next" });
    const hook = renderHook(({ id }) => useProjectDetail(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    const page = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(page.promise).mockResolvedValueOnce({ ...project, id: 2, materials: [] });
    act(() => hook.result.current.material.loadMoreMaterials());
    hook.rerender({ id: "2" });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(2));
    await act(async () => { page.resolve({ ...project, materials: [b] }); });
    expect(hook.result.current.data?.id).toBe(2);
    expect(hook.result.current.data?.materials).toEqual([]);
  });
});

describe("材料编辑请求的会话归属", () => {
  it("旧列表编辑加载新详情后，保存正文不会覆盖另一标签的新标题", async () => {
    const hook = await setup();
    const current = { ...loadedA, title: "另一标签的新标题" };
    vi.mocked(jsonFetch).mockResolvedValueOnce(current);
    act(() => hook.result.current.material.startEdit(a));
    await waitFor(() => expect(hook.result.current.material.loadingEdit).toBe(false));
    act(() => hook.result.current.material.setEditContent("只修改正文"));
    await act(async () => { await hook.result.current.material.saveEdit(a.id); });
    const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch![1]!.body as string)).toEqual({
      title: current.title, content: "只修改正文", expectedRevision: current.revision,
    });
  });

  it("A 的晚到详情不覆盖正在编辑的 B", async () => {
    const hook = await setup();
    const requestA = deferred<Material>();
    const requestB = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(requestA.promise).mockReturnValueOnce(requestB.promise);
    act(() => { hook.result.current.material.startEdit(a); hook.result.current.material.startEdit(b); });
    await act(async () => { requestB.resolve(loadedB); await requestB.promise; });
    act(() => hook.result.current.material.setEditContent("B 未保存的新输入"));
    await act(async () => { requestA.resolve(loadedA); await requestA.promise; });
    expect(hook.result.current.material.editingId).toBe(b.id);
    expect(hook.result.current.material.editContent).toBe("B 未保存的新输入");
    expect(hook.result.current.material.editRevision).toBe(loadedB.revision);
  });

  it("同材料详情不会覆盖加载期间产生的草稿", async () => {
    const hook = await setup();
    const request = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    act(() => hook.result.current.material.startEdit(a));
    act(() => hook.result.current.material.setEditTitle("尚未保存的标题"));
    act(() => hook.result.current.material.setEditContent("尚未保存的正文"));
    await act(async () => { request.resolve(loadedA); await request.promise; });
    expect(hook.result.current.material.editContent).toBe("尚未保存的正文");
    expect(hook.result.current.material.editTitle).toBe("尚未保存的标题");
    expect(hook.result.current.material.editRevision).toBe(loadedA.revision);
  });

  it("取消后重新编辑同一材料只接收新会话的详情", async () => {
    const hook = await setup();
    const previous = deferred<Material>();
    const current = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    act(() => hook.result.current.material.startEdit(a));
    act(() => hook.result.current.material.setEditingId(null));
    act(() => hook.result.current.material.startEdit(a));
    await act(async () => { current.resolve({ ...loadedA, content: "新会话正文" }); await current.promise; });
    await act(async () => { previous.resolve(loadedA); await previous.promise; });
    expect(hook.result.current.material.editContent).toBe("新会话正文");
  });

  it("没有加载 revision 时不能提交保存", async () => {
    const hook = await setup();
    const request = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    act(() => hook.result.current.material.startEdit(a));
    await act(async () => { await hook.result.current.material.saveEdit(a.id); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    await act(async () => { request.resolve(loadedA); await request.promise; });
  });
});

function MaterialsView() {
  const view = useProjectDetail("1");
  return <ProjectMaterialsPanel {...view.material} materials={view.data?.materials ?? []} error={view.error}
    projectId={1} repoPaths={[]} onAddRepoPath={() => {}} onRemoveRepoPath={() => {}}
    onClearRepoPaths={() => {}} onOpenScanModal={() => {}} />;
}

it("详情加载时锁定输入，失败可见且能重试，成功后可以编辑", async () => {
  const request = deferred<Material>();
  vi.mocked(jsonFetch).mockResolvedValueOnce(project).mockReturnValueOnce(request.promise);
  render(<MaterialsView />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "编辑" })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
  const content = screen.getByRole("textbox", { name: "编辑「材料 A」材料正文" }) as HTMLTextAreaElement;
  expect(content.disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("加载");
  await act(async () => { request.reject(new Error("详情请求失败")); await request.promise.catch(() => {}); });
  expect(screen.getByRole("alert").textContent).toContain("详情请求失败");
  expect(content.disabled).toBe(true);
  vi.mocked(jsonFetch).mockResolvedValueOnce(loadedA);
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await waitFor(() => expect(content.disabled).toBe(false));
  expect(content.value).toBe("A 正文");
  expect(screen.queryByRole("alert")).toBeNull();
});
