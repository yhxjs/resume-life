// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { HttpError } from "@/lib/fetcher";
import { useProjectDetail } from "../use-project-detail";

const calls = vi.hoisted(() => ({ json: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: calls.confirm, alertDialog: calls.alert }));
const material = { id: 11, title: "删除对象", content: "完整原文 <T> &amp;", revision: "a".repeat(64), source: "text", filename: "", created_at: "2026-11-02" };
const other = { ...material, id: 22, title: "其他材料" };
const project = { id: 1, name: "删除核对", summary: emptySummary(), summary_updated_at: "", materials: [material, other], materials_total: 2 };
beforeEach(() => { calls.json.mockReset().mockResolvedValue(project); calls.confirm.mockReset().mockResolvedValue(true); calls.alert.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);
const deletes = () => calls.json.mock.calls.filter(([, init]) => init?.method === "DELETE");
async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  return hook;
}

describe("材料删除确认与核对", () => {
  it.each([{}, { ok: false }, { ok: "true" }])("坏确认 %j 且读取失败不能移除材料或重复删除", async response => {
    const hook = await setup();
    calls.json.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("合成核对失败"));
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(hook.result.current.data?.materials).toEqual([material, other]);
    expect(hook.result.current.material.materialDeletion).toMatchObject({ phase: "unknown" });
    expect(calls.json).toHaveBeenLastCalledWith("/api/projects/1/materials/11", expect.objectContaining({ cache: "no-store" }));
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); await hook.result.current.material.removeMaterial(22, other.title); });
    expect(deletes()).toHaveLength(1);
    expect(calls.confirm).toHaveBeenCalledOnce();
  });

  it("从确认开始同步互斥，取消释放，离页中止所属确认", async () => {
    const hook = await setup();
    const confirmation = Promise.withResolvers<boolean>();
    calls.confirm.mockReturnValueOnce(confirmation.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.material.removeMaterial(11, material.title); void hook.result.current.material.removeMaterial(22, other.title); });
    await waitFor(() => expect(calls.confirm).toHaveBeenCalledOnce());
    expect(hook.result.current.material.materialDeleting).toBe(true);
    const signal = calls.confirm.mock.calls[0]![0].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    hook.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { confirmation.resolve(true); await pending; });
    expect(deletes()).toHaveLength(0);
  });

  it.each(["network", "408", "503"])("%s 后读取 404 确认不存在，旧列表重现仍不恢复已删材料", async outcome => {
    const hook = await setup();
    calls.json.mockRejectedValueOnce(outcome === "network" ? new Error("断线") : new HttpError("合成超时", Number(outcome)))
      .mockRejectedValueOnce(new HttpError("不存在", 404)).mockResolvedValueOnce(project);
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(hook.result.current.data?.materials).toEqual([other]);
    expect(hook.result.current.data?.materials_total).toBe(1);
    expect(hook.result.current.material.materialDeleting).toBe(false);
    await act(async () => { await hook.result.current.material.refreshMaterials(); await hook.result.current.material.removeMaterial(11, material.title); });
    expect(hook.result.current.data?.materials).toEqual([other]);
    expect(deletes()).toHaveLength(1);
    act(() => hook.result.current.material.startEdit(material));
    expect(hook.result.current.material.editingId).toBeNull();
  });

  it.each(["wrong-id", "missing-body"])("核对 %s 锁住写入，显式重读只发送一次 GET，404 后清理编辑器", async kind => {
    const hook = await setup();
    act(() => hook.result.current.material.startEdit(material));
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce(kind === "wrong-id" ? { ...material, id: 99 } : { ...material, content: undefined });
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(hook.result.current.material.materialDeletion?.phase).toBe("unknown");
    const read = Promise.withResolvers<unknown>();
    calls.json.mockReturnValueOnce(read.promise).mockRejectedValueOnce(new Error("列表失败"));
    let pending: Promise<void> | undefined;
    act(() => { pending = hook.result.current.material.retryMaterialDeletion(); void hook.result.current.material.retryMaterialDeletion(); });
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(calls.json.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    await act(async () => { read.reject(new HttpError("不存在", 404)); await pending; });
    expect(hook.result.current.material.editingId).toBeNull();
    expect(hook.result.current.data?.materials).toEqual([other]);
    expect(hook.result.current.material.materialRefreshError).toContain("材料已删除，列表刷新失败");
    expect(deletes()).toHaveLength(1);
  });

  it("有效读取确认仍存在，不移除原稿，用户再次确认才重发 DELETE", async () => {
    const hook = await setup();
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce(material);
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(hook.result.current.material.materialDeleting).toBe(false);
    expect(hook.result.current.material.materialDeletion?.message).toContain("仍存在");
    expect(hook.result.current.data?.materials).toEqual([material, other]);
    calls.json.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ...project, materials: [other], materials_total: 1 });
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(calls.confirm).toHaveBeenCalledTimes(2);
    expect(deletes()).toHaveLength(2);
  });

  it.each([400, 403])("明确 %i 不自动核对，保留材料并解除删除锁", async code => {
    const hook = await setup();
    calls.json.mockRejectedValueOnce(new HttpError("明确拒绝", code));
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(calls.json).toHaveBeenCalledTimes(2);
    expect(hook.result.current.material.materialDeleting).toBe(false);
    expect(hook.result.current.material.materialDeletion?.message).toContain("明确拒绝");
    expect(hook.result.current.data?.materials).toEqual([material, other]);
  });

  it("保存等待与结果未知期间不能开始删除，删除确认期间不能开始保存", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.startEdit(material));
    const write = Promise.withResolvers<unknown>();
    calls.json.mockReturnValueOnce(write.promise).mockRejectedValueOnce(new Error("无法核对保存"));
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.material.saveEdit(11); });
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(calls.confirm).not.toHaveBeenCalled();
    await act(async () => { write.resolve({}); await saving; });
    await act(async () => { await hook.result.current.material.removeMaterial(11, material.title); });
    expect(calls.confirm).not.toHaveBeenCalled();
    calls.json.mockResolvedValueOnce(material).mockResolvedValueOnce(project);
    await act(async () => { await hook.result.current.material.retryEditSaveCheck(); });
    act(() => hook.result.current.material.startEdit(material));
    const confirmation = Promise.withResolvers<boolean>();
    calls.confirm.mockReturnValueOnce(confirmation.promise);
    let deleting!: Promise<void>;
    act(() => { deleting = hook.result.current.material.removeMaterial(11, material.title); });
    await waitFor(() => expect(calls.confirm).toHaveBeenCalledOnce());
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(calls.json.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    await act(async () => { confirmation.resolve(false); await deleting; });
    expect(hook.result.current.material.materialDeleting).toBe(false);
  });

  it.each([material, other])("删除等待时打开 $title，确认后只关闭已删材料编辑器", async editing => {
    const hook = await setup();
    const deletion = Promise.withResolvers<unknown>();
    calls.json.mockReturnValueOnce(deletion.promise).mockRejectedValueOnce(new Error("列表失败"));
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.material.removeMaterial(11, material.title); });
    await waitFor(() => expect(deletes()).toHaveLength(1));
    act(() => hook.result.current.material.startEdit(editing));
    await act(async () => { deletion.resolve({ ok: true }); await pending; });
    expect(hook.result.current.material.editingId).toBe(editing.id === material.id ? null : other.id);
    if (editing.id === other.id) expect(hook.result.current.material.editContent).toBe(other.content);
  });

  it.each(["delete", "check"])("离页取消 %s 等待，旧结果和保留的重读回调不能刷新或重发", async phase => {
    const hook = await setup();
    const reply = Promise.withResolvers<unknown>();
    if (phase === "check") calls.json.mockRejectedValueOnce(new HttpError("响应失败", 503));
    calls.json.mockReturnValueOnce(reply.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.material.removeMaterial(11, material.title); });
    const count = phase === "check" ? 3 : 2;
    await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(count));
    const signal = calls.json.mock.calls[count - 1]![1].signal as AbortSignal;
    const retained = hook.result.current.material;
    hook.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { reply.resolve({ ok: true }); await pending; await retained.retryMaterialDeletion(); });
    expect(calls.json).toHaveBeenCalledTimes(count);
    expect(calls.alert).not.toHaveBeenCalled();
  });
});
