// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { HttpError } from "@/lib/fetcher";
import { useProjectDetail } from "../use-project-detail";

const calls = vi.hoisted(() => ({ json: vi.fn(), api: vi.fn(), alert: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/api-fetch", () => ({ apiFetch: calls.api }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: calls.alert, confirmDialog: calls.confirm }));
const material = { id: 11, title: "原材料", content: "原始正文", revision: "a".repeat(64), source: "text", filename: "", created_at: "" };
const project = { id: 1, name: "材料项目", summary: emptySummary(), summary_updated_at: "", summary_revision_id: 0, materials: [material] };
beforeEach(() => {
  calls.json.mockReset().mockResolvedValue(project);
  calls.api.mockReset().mockImplementation(async (_url, init) => {
    const file = init.body instanceof FormData ? init.body.get("file") as File : null;
    const body = file ? null : JSON.parse(init.body);
    return Response.json({ id: 12, title: file ? file.name : body.title || body.content.trim().slice(0, 20),
      source: file ? "file" : "paste", filename: file?.name ?? "" }, { status: 201 });
  });
  calls.alert.mockReset().mockResolvedValue(undefined); calls.confirm.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);
async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  return hook;
}

describe("材料写入结果与后续刷新分离", () => {
  it.each(["paste", "file"])("%s 新增已成功而刷新失败，已提交输入清空并提示已导入", async kind => {
    const hook = await setup();
    act(() => { hook.result.current.material.setMatTitle("新材料"); hook.result.current.material.setMatContent("只参与联调");
      hook.result.current.material.setFile(new File(["只参与联调"], "note.txt", { type: "text/plain" })); });
    calls.json.mockRejectedValueOnce(new Error("列表暂不可用"));
    await act(async () => { if (kind === "paste") await hook.result.current.material.addPaste(); else await hook.result.current.material.addFile(); });
    expect(kind === "paste" ? hook.result.current.material.matContent : hook.result.current.material.file).toBe(kind === "paste" ? "" : null);
    expect(hook.result.current.error).toBe("");
    expect(hook.result.current.material.materialRefreshError).toContain("材料已导入，列表刷新失败：列表暂不可用");
    expect(calls.api).toHaveBeenCalledOnce();
    calls.json.mockResolvedValueOnce({ ...project, materials: [...project.materials, { ...material, id: 12, title: "新材料" }] });
    await act(async () => { await hook.result.current.material.refreshMaterials(); });
    expect(hook.result.current.material.materialRefreshError).toBe("");
    expect(hook.result.current.data?.materials).toHaveLength(2);
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it("新增写入失败保留输入，不显示已写入或触发刷新", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.setMatContent("未保存材料"));
    calls.api.mockResolvedValueOnce(Response.json({ error: "导入失败" }, { status: 400 }));
    await act(async () => { await hook.result.current.material.addPaste(); });
    expect(hook.result.current.material.matContent).toBe("未保存材料");
    expect(hook.result.current.error).toBe("导入失败");
    expect(calls.json).toHaveBeenCalledTimes(1);
  });

  it("同一帧重复导入只能发出一次写请求", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.setMatContent("只导入一次"));
    await act(async () => { await Promise.all([hook.result.current.material.addPaste(), hook.result.current.material.addPaste()]); });
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it("编辑已成功而刷新失败不报保存失败，本地确认缓存可继续编辑新版本", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.startEdit(material));
    act(() => hook.result.current.material.setEditContent("更新正文"));
    calls.json.mockResolvedValueOnce({ ok: true, revision: "b".repeat(64) }).mockRejectedValueOnce(new Error("列表暂不可用"));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(calls.alert).not.toHaveBeenCalled();
    expect(hook.result.current.material.editingId).toBeNull();
    expect(hook.result.current.material.materialRefreshError).toContain("材料已保存，列表刷新失败");
    expect(hook.result.current.data?.materials[0]).toMatchObject({ content: "更新正文", revision: "b".repeat(64) });
    act(() => hook.result.current.material.startEdit(hook.result.current.data!.materials[0]!));
    expect(hook.result.current.material.editRevision).toBe("b".repeat(64));
    expect(hook.result.current.material.editContent).toBe("更新正文");
  });

  it("删除已成功而刷新失败保留删除结果，不显示删除失败或再次删除", async () => {
    const hook = await setup();
    calls.json.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("列表暂不可用"));
    await act(async () => { await hook.result.current.material.removeMaterial(11, "原材料"); });
    expect(calls.alert).not.toHaveBeenCalled();
    expect(hook.result.current.data?.materials).toHaveLength(0);
    expect(hook.result.current.material.materialRefreshError).toContain("材料已删除，列表刷新失败");
  });

  it("导入等待期间的新输入和新文件不会被旧提交清空", async () => {
    const hook = await setup();
    const pending = Promise.withResolvers<Response>();
    act(() => hook.result.current.material.setMatContent("提交正文"));
    calls.api.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.material.addPaste(); });
    act(() => { hook.result.current.material.setMatTitle("下一篇标题"); hook.result.current.material.setMatContent("下一篇正文"); });
    calls.json.mockRejectedValueOnce(new Error("刷新失败"));
    await act(async () => { pending.resolve(Response.json({ id: 12, title: "提交正文", source: "paste", filename: "" }, { status: 201 })); await saving; });
    expect(hook.result.current.material.matContent).toBe("下一篇正文");
    expect(hook.result.current.material.matTitle).toBe("下一篇标题");
    const file = new File(["提交文件"], "old.txt");
    const next = new File(["下一份文件"], "next.txt");
    act(() => hook.result.current.material.setFile(file));
    const upload = Promise.withResolvers<Response>();
    calls.api.mockReturnValueOnce(upload.promise);
    act(() => { saving = hook.result.current.material.addFile(); });
    act(() => hook.result.current.material.setFile(next));
    await act(async () => { upload.resolve(Response.json({ id: 13, title: "old.txt", source: "file", filename: "old.txt" }, { status: 201 })); await saving; });
    expect(hook.result.current.material.file).toBe(next);
  });

  it("列表重试失败保留已写入提示，重复点击重试只发一次读取", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.setMatContent("提交正文"));
    calls.json.mockRejectedValueOnce(new Error("首次刷新失败"));
    await act(async () => { await hook.result.current.material.addPaste(); });
    const pending = Promise.withResolvers<typeof project>();
    calls.json.mockReturnValueOnce(pending.promise);
    let first!: Promise<void>;
    act(() => { first = hook.result.current.material.refreshMaterials(); void hook.result.current.material.refreshMaterials(); });
    expect(hook.result.current.material.refreshingMaterials).toBe(true);
    expect(calls.json).toHaveBeenCalledTimes(3);
    await act(async () => { pending.reject(new Error("重试仍失败")); await first; });
    expect(hook.result.current.material.materialRefreshError).toBe("材料已导入，列表刷新失败：重试仍失败");
    expect(hook.result.current.material.refreshingMaterials).toBe(false);
    expect(calls.api).toHaveBeenCalledOnce();
  });

  it.each(["edit", "delete"])("%s 写入失败仍报告失败，保留原材料且不刷新", async kind => {
    const hook = await setup();
    calls.json.mockRejectedValueOnce(new HttpError("写入未完成", 400));
    if (kind === "edit") {
      act(() => hook.result.current.material.startEdit(material));
      await act(async () => { await hook.result.current.material.saveEdit(11); });
      expect(hook.result.current.material.editingId).toBe(11);
    } else await act(async () => { await hook.result.current.material.removeMaterial(11, "原材料"); });
    if (kind === "edit") expect(calls.alert).toHaveBeenCalledWith({ title: "保存失败", message: "写入未完成" });
    else expect(hook.result.current.material.materialDeletion?.message).toBe("删除失败：写入未完成");
    expect(calls.json).toHaveBeenCalledTimes(2);
    expect(hook.result.current.data?.materials).toEqual([material]);
    expect(hook.result.current.material.materialRefreshError).toBe("");
  });

  it("保存甲材料期间转去编辑乙材料，甲回包和刷新失败不关闭乙编辑器", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.startEdit(material));
    const pending = Promise.withResolvers<{ ok: true; revision: string }>();
    calls.json.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("列表失败"));
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.material.saveEdit(11); });
    act(() => hook.result.current.material.startEdit({ ...material, id: 22, title: "乙材料", content: "乙正文" }));
    await act(async () => { pending.resolve({ ok: true, revision: "b".repeat(64) }); await saving; });
    expect(hook.result.current.material.editingId).toBe(22);
    expect(hook.result.current.material.editContent).toBe("乙正文");
    expect(calls.alert).not.toHaveBeenCalled();
  });

  it("新写入后的刷新优先，旧重试失败不覆盖新提示或解除刷新锁", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.setMatContent("提交正文"));
    calls.json.mockRejectedValueOnce(new Error("首次刷新失败"));
    await act(async () => { await hook.result.current.material.addPaste(); });
    const oldRead = Promise.withResolvers<typeof project>();
    calls.json.mockReturnValueOnce(oldRead.promise);
    let retrying!: Promise<void>;
    act(() => { retrying = hook.result.current.material.refreshMaterials(); });
    act(() => hook.result.current.material.startEdit(material));
    const newRead = Promise.withResolvers<typeof project>();
    calls.json.mockResolvedValueOnce({ ok: true, revision: "b".repeat(64) }).mockReturnValueOnce(newRead.promise);
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.material.saveEdit(11); });
    await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(5));
    await act(async () => { oldRead.reject(new Error("旧读取失败")); await retrying; });
    expect(hook.result.current.material.refreshingMaterials).toBe(true);
    expect(hook.result.current.material.materialRefreshError).not.toContain("旧读取失败");
    await act(async () => { newRead.resolve(project); await saving; });
    expect(hook.result.current.material.refreshingMaterials).toBe(false);
    expect(hook.result.current.material.materialRefreshError).toBe("");
  });

  it("卸载后保留的材料导入、删除和刷新回调不再发起请求", async () => {
    const hook = await setup();
    act(() => hook.result.current.material.setMatContent("离页材料"));
    const retained = hook.result.current.material;
    hook.unmount();
    await retained.addPaste();
    await retained.removeMaterial(11, "原材料");
    await retained.refreshMaterials();
    expect(calls.api).not.toHaveBeenCalled();
    expect(calls.confirm).not.toHaveBeenCalled();
    expect(calls.json).toHaveBeenCalledTimes(1);
  });
});
