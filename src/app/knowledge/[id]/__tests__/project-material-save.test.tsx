// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { HttpError } from "@/lib/fetcher";
import { useProjectDetail } from "../use-project-detail";

const calls = vi.hoisted(() => ({ json: vi.fn(), alert: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: calls.alert }));
const material = { id: 11, title: "原材料", content: "原正文", revision: "a".repeat(64), source: "text", filename: "", created_at: "2026-11-01" };
const saved = { ...material, title: "核实的标题", content: "更正职责 <T> &amp;\n仅参与校验", revision: "b".repeat(64) };
const project = { id: 1, name: "材料核对", summary: emptySummary(), summary_updated_at: "", materials: [{ ...material, content_length: Array.from(material.content).length }] };
beforeEach(() => { calls.json.mockReset().mockResolvedValue(project); calls.alert.mockReset().mockResolvedValue(undefined); });
afterEach(cleanup);
const writes = () => calls.json.mock.calls.filter(([, init]) => init?.method === "PATCH");
async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  act(() => hook.result.current.material.startEdit(material));
  act(() => { hook.result.current.material.setEditTitle(saved.title); hook.result.current.material.setEditContent(saved.content); });
  return hook;
}

describe("材料保存确认和只读恢复", () => {
  it.each([{}, { ok: false, revision: saved.revision }, { ok: true }, { ok: true, revision: 1 }, { ok: true, revision: "broken" }])("异常确认 %j 不关闭原稿，核对失败时阻止再次写入", async response => {
    const hook = await setup();
    calls.json.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("合成读取失败"));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(hook.result.current.material.editingId).toBe(11);
    expect(hook.result.current.material.editContent).toBe(saved.content);
    expect(hook.result.current.material.editRevision).toBe(material.revision);
    expect(hook.result.current.material.editSaveRecovery).toMatchObject({ retry: true, checking: false });
    expect(calls.json).toHaveBeenLastCalledWith("/api/projects/1/materials/11", expect.objectContaining({ cache: "no-store" }));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(writes()).toHaveLength(1);
    expect(calls.alert).not.toHaveBeenCalled();
  });

  it.each(["network", "408", "503"])("%s 后读取完整匹配材料确认保存，刷新失败仍保留新正文和版本", async kind => {
    const hook = await setup();
    calls.json.mockRejectedValueOnce(kind === "network" ? new Error("断线") : new HttpError("合成响应失败", Number(kind)))
      .mockResolvedValueOnce(saved).mockRejectedValueOnce(new Error("列表失败"));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(hook.result.current.material.editingId).toBeNull();
    expect(hook.result.current.material.editSaveRecovery).toBeNull();
    expect(hook.result.current.data?.materials[0]).toMatchObject(saved);
    expect(hook.result.current.material.materialRefreshError).toContain("已核对材料包含本次提交内容，列表刷新失败");
    expect(writes()).toHaveLength(1);
    expect(calls.alert).not.toHaveBeenCalled();
  });

  it.each(["wrong-id", "missing-content", "broken-revision"])("核对 %s 后只读重试互斥，保留新编辑并用确认版本继续保存", async kind => {
    const hook = await setup();
    const broken = kind === "wrong-id" ? { ...saved, id: 12 } : kind === "missing-content" ? { ...saved, content: undefined } : { ...saved, revision: "x" };
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce(broken);
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(hook.result.current.material.editSaveRecovery?.retry).toBe(true);
    const read = Promise.withResolvers<unknown>();
    calls.json.mockReturnValueOnce(read.promise).mockRejectedValueOnce(new Error("列表失败"));
    let pending: Promise<void> | undefined;
    act(() => { pending = hook.result.current.material.retryEditSaveCheck(); void hook.result.current.material.retryEditSaveCheck(); });
    act(() => { hook.result.current.material.setEditTitle("核对时的新标题"); hook.result.current.material.setEditContent("核对时的新编辑"); });
    await act(async () => { read.resolve(saved); await pending; });
    expect(hook.result.current.material.editingId).toBe(11);
    expect(hook.result.current.material.editTitle).toBe("核对时的新标题");
    expect(hook.result.current.material.editContent).toBe("核对时的新编辑");
    expect(hook.result.current.material.editRevision).toBe(saved.revision);
    expect(calls.json.mock.calls.filter(([, init]) => init?.cache === "no-store")).toHaveLength(2);
    calls.json.mockResolvedValueOnce({ ok: true, revision: "c".repeat(64) }).mockResolvedValueOnce(project);
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1]![1].body)).toEqual({ title: "核对时的新标题", content: "核对时的新编辑", expectedRevision: saved.revision });
  });

  it("有效但不匹配的存档保留原稿及基准，显式重试仍受版本条件保护", async () => {
    const hook = await setup();
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce({ ...saved, content: "另一页面更正" });
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(hook.result.current.material.editSaveRecovery).toMatchObject({ retry: false });
    expect(hook.result.current.material.editContent).toBe(saved.content);
    expect(hook.result.current.material.editRevision).toBe(material.revision);
    expect(hook.result.current.data?.materials[0]).toMatchObject({ content: "另一页面更正", content_length: Array.from("另一页面更正").length });
    calls.json.mockRejectedValueOnce(new HttpError("版本冲突", 409));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(JSON.parse(writes()[1]![1].body).expectedRevision).toBe(material.revision);
    expect(calls.alert).toHaveBeenCalledWith({ title: "保存失败", message: "版本冲突" });
  });

  it("明确拒绝不额外回读，保留可编辑原稿", async () => {
    const hook = await setup();
    calls.json.mockRejectedValueOnce(new HttpError("输入无效", 400));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(calls.json).toHaveBeenCalledTimes(2);
    expect(hook.result.current.material.editSaveRecovery).toBeNull();
    expect(hook.result.current.material.editingId).toBe(11);
  });

  it("核对到材料已删除时保留原稿并释放核对锁", async () => {
    const hook = await setup();
    calls.json.mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("材料不存在", 404));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(hook.result.current.material.editSaveRecovery).toMatchObject({ retry: false, message: expect.stringContaining("已不存在") });
    expect(hook.result.current.material.editContent).toBe(saved.content);
  });

  it("核对期间切换编辑器，旧确认不能关闭或替换新编辑内容与版本", async () => {
    const hook = await setup();
    const read = Promise.withResolvers<unknown>();
    calls.json.mockResolvedValueOnce({}).mockReturnValueOnce(read.promise).mockRejectedValueOnce(new Error("列表失败"));
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.material.saveEdit(11); });
    await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(3));
    act(() => hook.result.current.material.startEdit({ ...material, id: 22, content: "另一材料草稿", revision: "c".repeat(64) }));
    await act(async () => { read.resolve(saved); await pending; });
    expect(hook.result.current.material.editingId).toBe(22);
    expect(hook.result.current.material.editContent).toBe("另一材料草稿");
    expect(hook.result.current.material.editRevision).toBe("c".repeat(64));
  });

  it("离页取消保存与核对，迟到回复不刷新旧页面", async () => {
    const hook = await setup();
    const read = Promise.withResolvers<unknown>();
    calls.json.mockResolvedValueOnce({}).mockReturnValueOnce(read.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.material.saveEdit(11); });
    await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(3));
    const signal = calls.json.mock.calls[2]![1].signal as AbortSignal;
    hook.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { read.resolve(saved); await pending; });
    expect(calls.json).toHaveBeenCalledTimes(3);
    expect(calls.alert).not.toHaveBeenCalled();
  });

  it("正文没有变化时允许核对到相同修订号，不要求内容哈希递增", async () => {
    const hook = await setup();
    act(() => { hook.result.current.material.setEditTitle(material.title); hook.result.current.material.setEditContent(material.content); });
    calls.json.mockRejectedValueOnce(new Error("断线")).mockResolvedValueOnce(material).mockResolvedValueOnce(project);
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(hook.result.current.material.editingId).toBeNull();
    expect(hook.result.current.material.editSaveRecovery).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it("取消并重开同一材料后，旧核对不能替新会话的旧正文推进版本", async () => {
    const hook = await setup();
    const read = Promise.withResolvers<unknown>();
    calls.json.mockResolvedValueOnce({}).mockReturnValueOnce(read.promise).mockRejectedValueOnce(new Error("列表失败"));
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.material.saveEdit(11); });
    await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(3));
    act(() => hook.result.current.material.setEditingId(null));
    act(() => hook.result.current.material.startEdit(material));
    await act(async () => { read.resolve(saved); await pending; });
    expect(hook.result.current.material.editingId).toBe(11);
    expect(hook.result.current.material.editContent).toBe(material.content);
    expect(hook.result.current.material.editRevision).toBe(material.revision);
    calls.json.mockRejectedValueOnce(new HttpError("版本冲突", 409));
    await act(async () => { await hook.result.current.material.saveEdit(11); });
    expect(JSON.parse(writes()[1]![1].body).expectedRevision).toBe(material.revision);
  });
});
