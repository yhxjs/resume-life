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
  await waitFor(() => expect(jsonFetch).toHaveBeenCalledWith("/api/templates"));
  await act(async () => { await Promise.resolve(); });
  act(() => { hook.result.current.loadStyle(a); hook.result.current.setAiPrompt("生成样式"); });
  return hook;
}

describe("模板异步操作的编辑归属", () => {
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
    const request = deferred<void>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.removeCustom({ ...a, created_at: "", updated_at: "" }); });
    await act(async () => { await Promise.resolve(); });
    act(() => hook.result.current.loadStyle(b));
    await act(async () => { request.resolve(undefined); await pending; });
    expect(hook.result.current.editingId).toBe(b.id);
    expect(hook.result.current.draftName).toBe(b.name);
    expect(hook.result.current.draft).toEqual(b.style);
  });

  it("删除当前仍在编辑的模板后解除模板绑定", async () => {
    const hook = await setup();
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
    await act(async () => { request.resolve({ ...a, id: 3, name: "服务器保存的 A", created_at: "", updated_at: "" }); await pending; });
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
