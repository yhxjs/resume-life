// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { useProjectDetail, type Material } from "../use-project-detail";

const calls = vi.hoisted(() => ({ json: vi.fn(), alert: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: calls.alert, confirmDialog: calls.confirm }));
const metadata: Material = { id: 11, title: "原材料", source: "text", filename: "", created_at: "" };
const old = { ...metadata, content: "旧正文", revision: "a".repeat(64) };
const fresh = { ...metadata, title: "已更正材料", content: "新正文", revision: "b".repeat(64) };
const project = { id: 1, name: "请求归属项目", summary: emptySummary(), summary_updated_at: "", materials: [metadata] };
beforeEach(() => {
  calls.json.mockReset().mockResolvedValue(project);
  calls.alert.mockReset().mockResolvedValue(undefined);
  calls.confirm.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);
async function setup() {
  const hook = renderHook(({ id }) => useProjectDetail(id), { initialProps: { id: "1" } });
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  return hook;
}

describe("材料详情缓存和请求归属", () => {
  it("取消并重开编辑，旧详情晚到不能覆盖新会话缓存或下一次编辑基准", async () => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise).mockResolvedValueOnce(fresh);
    act(() => hook.result.current.material.startEdit(metadata));
    act(() => hook.result.current.material.setEditingId(null));
    act(() => hook.result.current.material.startEdit(metadata));
    await waitFor(() => expect(hook.result.current.material.editRevision).toBe(fresh.revision));
    await act(async () => { first.resolve(old); await first.promise; });
    expect(hook.result.current.data?.materials[0]).toEqual(fresh);
    act(() => hook.result.current.material.startEdit(hook.result.current.data!.materials[0]!));
    expect(hook.result.current.material.editContent).toBe(fresh.content);
    expect(hook.result.current.material.editRevision).toBe(fresh.revision);
  });

  it.each(["success", "failure"])("展开原文的旧请求 %s 晚于编辑保存，不回退缓存或显示旧错误", async outcome => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise).mockResolvedValueOnce(old);
    let expanding!: Promise<void>;
    act(() => { expanding = hook.result.current.material.toggleMaterialExpanded(metadata); });
    act(() => hook.result.current.material.startEdit(metadata));
    await waitFor(() => expect(hook.result.current.material.editRevision).toBe(old.revision));
    act(() => { hook.result.current.material.setEditTitle(fresh.title); hook.result.current.material.setEditContent(fresh.content); });
    calls.json.mockResolvedValueOnce({ ok: true, revision: fresh.revision }).mockRejectedValueOnce(new Error("列表暂不可用"));
    await act(async () => { await hook.result.current.material.saveEdit(metadata.id); });
    await act(async () => { if (outcome === "success") first.resolve(old); else first.reject(new Error("旧原文失败")); await expanding; });
    expect(hook.result.current.data?.materials[0]).toMatchObject(fresh);
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.material.materialRefreshError).toContain("材料已保存");
  });

  it("刷新完成后的旧详情不能重新给元数据注入过期正文和版本", async () => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...project, materials: [{ ...metadata, title: fresh.title }] });
    let expanding!: Promise<void>;
    act(() => { expanding = hook.result.current.material.toggleMaterialExpanded(metadata); });
    await act(async () => { await hook.result.current.material.refreshMaterials(); });
    await act(async () => { first.resolve(old); await expanding; });
    expect(hook.result.current.data?.materials).toEqual([{ ...metadata, title: fresh.title }]);
    expect(hook.result.current.material.expanded).toBeNull();
  });

  it("切换项目后旧材料详情不能覆盖相同材料 ID 的新项目缓存", async () => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ...project, id: 2, materials: [fresh] });
    act(() => hook.result.current.material.startEdit(metadata));
    hook.rerender({ id: "2" });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(2));
    await act(async () => { first.resolve(old); await first.promise; });
    expect(hook.result.current.data?.materials[0]).toEqual(fresh);
  });

  it("收起旧原文，旧失败不污染当前页面", async () => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise);
    let expanding!: Promise<void>;
    act(() => { expanding = hook.result.current.material.toggleMaterialExpanded(metadata); });
    act(() => hook.result.current.material.setExpanded(null));
    await act(async () => { first.reject(new Error("已经收起的请求失败")); await expanding; });
    expect(hook.result.current.error).toBe("");
  });

  it("新编辑详情先到，仍展开的旧原文不能回退缓存", async () => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise).mockResolvedValueOnce(fresh);
    let expanding!: Promise<void>;
    act(() => { expanding = hook.result.current.material.toggleMaterialExpanded(metadata); });
    act(() => hook.result.current.material.startEdit(metadata));
    await waitFor(() => expect(hook.result.current.material.editRevision).toBe(fresh.revision));
    await act(async () => { first.resolve(old); await expanding; });
    expect(hook.result.current.data?.materials[0]).toEqual(fresh);
    expect(hook.result.current.material.editContent).toBe(fresh.content);
  });

  it("新原文请求不会让仍有效的编辑请求丢失基准或卡在加载中", async () => {
    const hook = await setup();
    const editing = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(editing.promise).mockResolvedValueOnce(fresh);
    act(() => hook.result.current.material.startEdit(metadata));
    await act(async () => { await hook.result.current.material.toggleMaterialExpanded(metadata); });
    await act(async () => { editing.resolve(old); await editing.promise; });
    expect(hook.result.current.material.loadingEdit).toBe(false);
    expect(hook.result.current.material.editRevision).toBe(old.revision);
    expect(hook.result.current.material.editContent).toBe(old.content);
    expect(hook.result.current.material.editError).toBe("");
    expect(hook.result.current.data?.materials[0]).toEqual(fresh);
  });

  it("新编辑详情已加载，旧原文失败不显示过期错误", async () => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise).mockResolvedValueOnce(fresh);
    let expanding!: Promise<void>;
    act(() => { expanding = hook.result.current.material.toggleMaterialExpanded(metadata); });
    act(() => hook.result.current.material.startEdit(metadata));
    await waitFor(() => expect(hook.result.current.material.editRevision).toBe(fresh.revision));
    await act(async () => { first.reject(new Error("旧原文失败")); await expanding; });
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.data?.materials[0]).toEqual(fresh);
  });

  it("当前原文读取失败仍显示错误，重新展开可成功读取", async () => {
    const hook = await setup();
    calls.json.mockRejectedValueOnce(new Error("当前原文失败")).mockResolvedValueOnce(fresh);
    await act(async () => { await hook.result.current.material.toggleMaterialExpanded(metadata); });
    expect(hook.result.current.error).toBe("当前原文失败");
    act(() => hook.result.current.material.setExpanded(null));
    await act(async () => { await hook.result.current.material.toggleMaterialExpanded(metadata); });
    expect(hook.result.current.data?.materials[0]).toEqual(fresh);
  });

  it("编辑基准读取失败仍保留错误，即使更新的原文已读成功", async () => {
    const hook = await setup();
    const editing = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(editing.promise).mockResolvedValueOnce(fresh);
    act(() => hook.result.current.material.startEdit(metadata));
    await act(async () => { await hook.result.current.material.toggleMaterialExpanded(metadata); });
    await act(async () => { editing.reject(new Error("编辑基准失败")); await editing.promise.catch(() => {}); });
    expect(hook.result.current.material.loadingEdit).toBe(false);
    expect(hook.result.current.material.editError).toBe("编辑基准失败");
    expect(hook.result.current.material.editRevision).toBe("");
    act(() => hook.result.current.material.retryEdit());
    expect(hook.result.current.material.editError).toBe("");
    expect(hook.result.current.material.editRevision).toBe(fresh.revision);
  });

  it.each(["success", "failure"])("删除后的旧原文 %s 不恢复条目或污染页面", async outcome => {
    const hook = await setup();
    const first = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ...project, materials: [] });
    let expanding!: Promise<void>;
    act(() => { expanding = hook.result.current.material.toggleMaterialExpanded(metadata); });
    await act(async () => { await hook.result.current.material.removeMaterial(metadata.id, metadata.title); });
    await act(async () => { if (outcome === "success") first.resolve(old); else first.reject(new Error("已删除的原文失败")); await expanding; });
    expect(hook.result.current.data?.materials).toEqual([]);
    expect(hook.result.current.material.expanded).toBeNull();
    expect(hook.result.current.error).toBe("");
  });

  it("同材料保存期间重开编辑，写入前开始的详情失效后可重试而不能混用新版本", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.startEdit(old));
    const saving = Promise.withResolvers<{ ok: true; revision: string }>();
    const editing = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(saving.promise).mockReturnValueOnce(editing.promise).mockRejectedValueOnce(new Error("刷新失败"));
    let writing!: Promise<void>;
    act(() => { writing = hook.result.current.material.saveEdit(metadata.id); });
    act(() => hook.result.current.material.startEdit(metadata));
    await act(async () => { saving.resolve({ ok: true, revision: fresh.revision }); await writing; });
    await act(async () => { editing.resolve(old); await editing.promise; });
    expect(hook.result.current.material.loadingEdit).toBe(false);
    expect(hook.result.current.material.editError).toContain("材料已更新");
    expect(hook.result.current.material.editRevision).toBe("");
    act(() => hook.result.current.material.retryEdit());
    expect(hook.result.current.material.editError).toBe("");
    expect(hook.result.current.material.editRevision).toBe(fresh.revision);
  });

  it("离页后保留的编辑和原文回调不再发起详情请求", async () => {
    const hook = await setup();
    const retained = hook.result.current.material;
    hook.unmount();
    retained.startEdit(metadata);
    await retained.toggleMaterialExpanded(metadata);
    expect(calls.json).toHaveBeenCalledTimes(1);
  });

  it("详情与保存同一轮完成，消费详情前仍须核对写入世代", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.startEdit(old));
    const saving = Promise.withResolvers<{ ok: true; revision: string }>();
    const editing = Promise.withResolvers<Material>();
    calls.json.mockReturnValueOnce(saving.promise).mockReturnValueOnce(editing.promise).mockRejectedValueOnce(new Error("刷新失败"));
    let writing!: Promise<void>;
    act(() => { writing = hook.result.current.material.saveEdit(metadata.id); });
    act(() => hook.result.current.material.startEdit(metadata));
    await act(async () => { editing.resolve(old); saving.resolve({ ok: true, revision: fresh.revision }); await writing; });
    expect(hook.result.current.material.editRevision).toBe("");
    expect(hook.result.current.material.editError).toContain("材料已更新");
    expect(hook.result.current.data?.materials[0]?.revision).toBe(fresh.revision);
  });
});
