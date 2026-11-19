// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { BUILTIN_STYLES, type CustomTemplate } from "@/lib/templates";
import { useTemplateLibrary } from "../use-template-library";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: vi.fn(), confirmDialog: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const a = { id: 1, name: "模板 A", style: { ...BUILTIN_STYLES.modern, accent: "#123456" } };
const b = { id: 2, name: "模板 B", style: { ...BUILTIN_STYLES.modern, accent: "#654321" } };
const aiStyle = { ...BUILTIN_STYLES.modern, accent: "#abcdef" };

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(alertDialog).mockReset().mockResolvedValue(undefined);
  vi.mocked(confirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

async function setup() {
  const hook = renderHook(() => useTemplateLibrary());
  await waitFor(() => expect(jsonFetch).toHaveBeenCalledWith("/api/templates", expect.objectContaining({ signal: expect.any(AbortSignal) })));
  await act(async () => { await Promise.resolve(); });
  act(() => { hook.result.current.loadStyle(a); hook.result.current.setAiPrompt("生成样式"); });
  return hook;
}

describe("模板异步操作的编辑归属", () => {
  describe.each(["修改描述", "清空描述"])("AI 生成期间%s", (change) => {
    it.each(["成功", "失败"])("忽略旧描述的%s回包，后续生成使用当前描述", async (outcome) => {
      const hook = await setup();
      const request = deferred<{ style: typeof aiStyle }>();
      vi.mocked(jsonFetch).mockClear().mockReturnValueOnce(request.promise);
      let pending!: Promise<void>;
      act(() => { pending = hook.result.current.aiGenerate(); });
      expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0]?.[1]?.body))).toEqual({ prompt: "生成样式" });
      const nextPrompt = change === "清空描述" ? "" : "新的生成描述";
      act(() => hook.result.current.setAiPrompt(nextPrompt));
      await act(async () => {
        if (outcome === "成功") request.resolve({ style: aiStyle });
        else request.reject(new Error("旧描述生成失败"));
        await pending;
      });
      expect(hook.result.current.aiPrompt).toBe(nextPrompt);
      expect(hook.result.current.draft).toEqual(a.style);
      expect(hook.result.current.draftName).toBe(a.name);
      expect(hook.result.current.editingId).toBe(a.id);
      expect(hook.result.current.aiNote).toBe("");
      expect(hook.result.current.aiLoading).toBe(false);
      expect(alertDialog).not.toHaveBeenCalled();
      if (change === "清空描述") {
        await act(async () => { await hook.result.current.aiGenerate(); });
        expect(jsonFetch).toHaveBeenCalledTimes(1);
        act(() => hook.result.current.setAiPrompt("重新填写的生成描述"));
      }
      const currentPrompt = hook.result.current.aiPrompt;
      vi.mocked(jsonFetch).mockResolvedValueOnce({ style: aiStyle });
      await act(async () => { await hook.result.current.aiGenerate(); });
      expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]?.[1]?.body))).toEqual({ prompt: currentPrompt });
      expect(hook.result.current.draft.accent).toBe(aiStyle.accent);
      expect(hook.result.current.editingId).toBeNull();
      expect(hook.result.current.aiNote).toBe("已生成并应用到预览，满意后可另存为新模板");
      expect(hook.result.current.aiLoading).toBe(false);
    });
  });

  it.each(["saveNew", "saveChanges"] as const)("%s 等待期间修改 AI 描述不影响保存确认与模板绑定", async (action) => {
    const hook = await setup();
    const saved = { ...a, id: action === "saveNew" ? 3 : a.id, name: "服务端确认名称", created_at: "", updated_at: "" };
    const request = deferred<CustomTemplate>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise).mockResolvedValueOnce({ items: [saved] });
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current[action](); });
    act(() => hook.result.current.setAiPrompt("保存期间修改的生成描述"));
    await act(async () => { request.resolve(saved); await pending; });
    expect(hook.result.current.aiPrompt).toBe("保存期间修改的生成描述");
    expect(hook.result.current.editingId).toBe(saved.id);
    expect(hook.result.current.draftName).toBe(saved.name);
    expect(hook.result.current.draft).toEqual(a.style);
    expect(hook.result.current.customs).toEqual([saved]);
    expect(hook.result.current.saving).toBe(false);
    expect(alertDialog).not.toHaveBeenCalled();
  });

  it.each(["saveNew", "saveChanges"] as const)("%s 成功而列表刷新失败时保留确认结果，重试只读取列表", async (action) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [{ ...a, created_at: "", updated_at: "" }] });
    const hook = await setup();
    const saved = { ...a, id: action === "saveNew" ? 3 : a.id, name: "已保存模板", created_at: "", updated_at: "" };
    vi.mocked(jsonFetch).mockClear().mockResolvedValueOnce(saved)
      .mockRejectedValueOnce(new Error("刷新失败"));
    await act(async () => { await hook.result.current[action](); });
    expect(alertDialog).not.toHaveBeenCalled();
    expect(hook.result.current.editingId).toBe(saved.id);
    expect(hook.result.current.draftName).toBe(saved.name);
    expect(hook.result.current.customs.find((template) => template.id === saved.id)).toEqual(saved);
    expect(hook.result.current.loadError).toBe("刷新失败");
    expect(hook.result.current.saving).toBe(false);
    const confirmed = [...hook.result.current.customs];
    vi.mocked(jsonFetch).mockResolvedValueOnce({ items: confirmed });
    act(() => hook.result.current.reloadCustoms());
    await waitFor(() => expect(hook.result.current.loadError).toBe(""));
    expect(hook.result.current.editingId).toBe(saved.id);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method)).toHaveLength(1);
    expect(vi.mocked(jsonFetch).mock.calls.at(-1)?.[1]?.method).toBeUndefined();
  });

  it("删除成功而刷新失败时移除列表项并解除当前绑定，重试不会再次删除", async () => {
    const template = { ...a, created_at: "", updated_at: "" };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [template] });
    const hook = await setup();
    vi.mocked(jsonFetch).mockClear().mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("删除后刷新失败"));
    await act(async () => { await hook.result.current.removeCustom(template); });
    expect(alertDialog).not.toHaveBeenCalled();
    expect(hook.result.current.editingId).toBeNull();
    expect(hook.result.current.customs).toEqual([]);
    expect(hook.result.current.draft).toEqual(a.style);
    expect(hook.result.current.loadError).toBe("删除后刷新失败");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [] });
    act(() => hook.result.current.reloadCustoms());
    await waitFor(() => expect(hook.result.current.loadError).toBe(""));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(1);
  });

  it.each(["saveNew", "saveChanges"] as const)("%s 在刷新结束前确认保存，刷新失败不覆盖期间的新编辑", async (action) => {
    const hook = await setup();
    const saved = { ...a, id: action === "saveNew" ? 3 : a.id, name: "服务端已确认", created_at: "", updated_at: "" };
    const refresh = deferred<{ items: CustomTemplate[] }>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved).mockReturnValueOnce(refresh.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current[action](); });
    await waitFor(() => {
      expect(hook.result.current.editingId).toBe(saved.id);
      expect(hook.result.current.draftName).toBe(saved.name);
    });
    expect(hook.result.current.customs).toContainEqual(saved);
    act(() => { hook.result.current.setDraftName("刷新期间的新名称"); hook.result.current.set("accent", "#998877"); });
    await act(async () => { refresh.reject(new Error("刷新失败")); await pending; });
    expect(hook.result.current.draftName).toBe("刷新期间的新名称");
    expect(hook.result.current.draft.accent).toBe("#998877");
    expect(hook.result.current.loadError).toBe("刷新失败");
    expect(alertDialog).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "成功", refreshFails: false },
    { outcome: "失败", refreshFails: false },
    { outcome: "成功", refreshFails: true },
    { outcome: "失败", refreshFails: true },
  ])("本次刷新失败=$refreshFails，保存后忽略较早列表读取的$outcome回包", async ({ outcome, refreshFails }) => {
    const hook = await setup();
    const oldList = deferred<{ items: CustomTemplate[] }>();
    vi.mocked(jsonFetch).mockReturnValueOnce(oldList.promise);
    act(() => hook.result.current.reloadCustoms());
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    const oldSignal = vi.mocked(jsonFetch).mock.calls.at(-1)?.[1]?.signal;
    const saved = { ...a, id: 3, name: "新模板", created_at: "", updated_at: "" };
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
    if (refreshFails) vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("本次刷新失败"));
    else vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [saved] });
    await act(async () => { await hook.result.current.saveNew(); });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "成功") oldList.resolve({ items: [] });
      else oldList.reject(new Error("过期列表错误"));
    });
    expect(hook.result.current.customs).toEqual([saved]);
    expect(hook.result.current.loadError).toBe(refreshFails ? "本次刷新失败" : "");
    expect(hook.result.current.editingId).toBe(saved.id);
  });

  it.each(["saveNew", "saveChanges"] as const)("%s 写入本身失败时保留列表和当前编辑，不误认成功或刷新", async (action) => {
    const template = { ...a, created_at: "", updated_at: "" };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [template] });
    const hook = await setup();
    vi.mocked(jsonFetch).mockClear().mockRejectedValueOnce(new Error("写入失败"));
    await act(async () => {
      await hook.result.current[action]();
    });
    expect(alertDialog).toHaveBeenCalledWith(expect.objectContaining({ message: "写入失败" }));
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.customs).toEqual([template]);
    expect(hook.result.current.editingId).toBe(a.id);
    expect(hook.result.current.draftName).toBe(a.name);
    expect(hook.result.current.draft).toEqual(a.style);
    expect(hook.result.current.loadError).toBe("");
    expect(hook.result.current.saving).toBe(false);
  });

  it("卸载时取消当前列表读取，旧失败回包不触发提示", async () => {
    const list = deferred<{ items: CustomTemplate[] }>();
    vi.mocked(jsonFetch).mockReturnValueOnce(list.promise);
    const hook = renderHook(() => useTemplateLibrary());
    const signal = vi.mocked(jsonFetch).mock.calls[0]?.[1]?.signal;
    hook.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { list.reject(new Error("卸载后的列表错误")); });
    expect(alertDialog).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });

  it("载入坏模板前确认，拒绝时保留当前编辑，确认后仅准备修复草稿", async () => {
    const hook = await setup();
    const broken = { ...b, corrupted: true };
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await act(async () => { await hook.result.current.loadStyle(broken); });
    expect(confirmDialog).toHaveBeenCalled();
    expect(hook.result.current.editingId).toBe(a.id);
    await act(async () => { await hook.result.current.loadStyle(broken); });
    expect(hook.result.current.editingId).toBe(b.id);
    expect(hook.result.current.aiNote).toMatch(/修复.*保存/);
    expect(vi.mocked(jsonFetch).mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  });

  it("删除 A 的回包不会清除等待期间选择的 B", async () => {
    const hook = await setup();
    const request = deferred<{ ok: true }>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.removeCustom({ ...a, created_at: "", updated_at: "" }); });
    await act(async () => { await Promise.resolve(); });
    act(() => hook.result.current.loadStyle(b));
    await act(async () => { request.resolve({ ok: true }); await pending; });
    expect(hook.result.current.editingId).toBe(b.id);
    expect(hook.result.current.draftName).toBe(b.name);
    expect(hook.result.current.draft).toEqual(b.style);
  });

  it("删除当前仍在编辑的模板后解除模板绑定", async () => {
    const hook = await setup();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true });
    await act(async () => { await hook.result.current.removeCustom({ ...a, created_at: "", updated_at: "" }); });
    expect(hook.result.current.editingId).toBeNull();
    expect(hook.result.current.draft).toEqual(a.style);
  });

  it.each(["切换模板", "修改样式", "修改名称"])("AI 回包不会覆盖之后的%s", async (action) => {
    const hook = await setup();
    const request = deferred<{ style: typeof aiStyle }>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.aiGenerate(); });
    act(() => {
      if (action === "切换模板") hook.result.current.loadStyle(b);
      if (action === "修改样式") hook.result.current.set("accent", "#999999");
      if (action === "修改名称") hook.result.current.setDraftName("新名称");
    });
    const current = { draft: hook.result.current.draft, name: hook.result.current.draftName, id: hook.result.current.editingId };
    await act(async () => { request.resolve({ style: aiStyle }); await pending; });
    expect(hook.result.current.draft).toEqual(current.draft);
    expect(hook.result.current.draftName).toBe(current.name);
    expect(hook.result.current.editingId).toBe(current.id);
    expect(hook.result.current.aiLoading).toBe(false);
  });

  it("未修改当前编辑时应用 AI 结果", async () => {
    const hook = await setup();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ style: aiStyle });
    await act(async () => { await hook.result.current.aiGenerate(); });
    expect(hook.result.current.draft.accent).toBe(aiStyle.accent);
    expect(hook.result.current.editingId).toBeNull();
  });

  it.each(["saveNew", "saveChanges"] as const)("%s 回包不会错配新选择的模板", async (action) => {
    const hook = await setup();
    const request = deferred<CustomTemplate>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current[action](); });
    act(() => hook.result.current.loadStyle(b));
    await act(async () => { request.resolve({ ...a, id: action === "saveNew" ? 3 : a.id, name: "服务器保存的 A", created_at: "", updated_at: "" }); await pending; });
    expect(hook.result.current.editingId).toBe(b.id);
    expect(hook.result.current.draftName).toBe(b.name);
    expect(hook.result.current.draft).toEqual(b.style);
    expect(hook.result.current.saving).toBe(false);
  });

  it.each(["saveNew", "saveChanges"] as const)("%s 刷新列表期间的重命名不会被回包覆盖", async (action) => {
    const hook = await setup();
    const refresh = deferred<{ items: CustomTemplate[] }>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...a, created_at: "", updated_at: "" }).mockReturnValueOnce(refresh.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current[action](); });
    await act(async () => { await Promise.resolve(); });
    act(() => hook.result.current.setDraftName("刷新时输入的新名称"));
    await act(async () => { refresh.resolve({ items: [] }); await pending; });
    expect(hook.result.current.draftName).toBe("刷新时输入的新名称");
  });

  it("同一事件内的重复保存与 AI 操作不会重复提交", async () => {
    const hook = await setup();
    const request = deferred<CustomTemplate>();
    vi.mocked(jsonFetch).mockClear().mockReturnValueOnce(request.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.saveNew();
      void hook.result.current.saveNew();
      void hook.result.current.saveChanges();
      void hook.result.current.aiGenerate();
    });
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.saving).toBe(true);
    await act(async () => { request.resolve({ ...a, id: 3, created_at: "", updated_at: "" }); await pending; });
    expect(hook.result.current.editingId).toBe(3);
    expect(hook.result.current.saving).toBe(false);
  });

  it("保存失败后可以重试且不清除草稿", async () => {
    const hook = await setup();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("保存失败"));
    await act(async () => { await hook.result.current.saveNew(); });
    expect(hook.result.current.saving).toBe(false);
    expect(hook.result.current.draft).toEqual(a.style);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...a, id: 3, created_at: "", updated_at: "" });
    await act(async () => { await hook.result.current.saveNew(); });
    expect(hook.result.current.editingId).toBe(3);
  });
});
