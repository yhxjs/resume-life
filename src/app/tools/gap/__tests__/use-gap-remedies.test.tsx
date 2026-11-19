// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { jsonFetch } from "@/lib/fetcher";
import { PRESET_REMEDIES } from "@/lib/career-gap-remedy";
import { useGapRemedies } from "../use-gap-remedies";

const state = vi.hoisted(() => ({ push: vi.fn(), reload: vi.fn(), confirm: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: state.confirm, alertDialog: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({ items: [], total: 0, nextCursor: null,
  loading: false, loadingMore: false, listError: "", failedCursor: undefined, reload: state.reload, loadMore: vi.fn() }) }));
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); state.confirm.mockReset().mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const story = "  休整两个月，没有学习或项目。<T> &amp;\n到岗时间尚未确认。  ";
function prepared() {
  const hook = renderHook(() => useGapRemedies());
  act(() => { hook.result.current.setRawStory(story); hook.result.current.setTargetRole("  C++ / C# <岗位>  ");
    hook.result.current.setScenarioType("gap"); hook.result.current.setPersonaStyle("composed"); });
  return hook;
}

it("同事件只提交一次，等待与导航期间固定四项背景并阻止预设替换", async () => {
  const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValue(pending.promise);
  const hook = prepared();
  act(() => { void hook.result.current.handleGenerate(); void hook.result.current.handleGenerate();
    hook.result.current.setRawStory("新故事"); hook.result.current.setTargetRole("另一岗位");
    hook.result.current.setScenarioType("resignation"); hook.result.current.setPersonaStyle("driven");
    hook.result.current.usePreset(PRESET_REMEDIES[0]!); void hook.result.current.removeRecord(7); });
  expect(jsonFetch).toHaveBeenCalledOnce(); expect(state.confirm).not.toHaveBeenCalled();
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toEqual({
    scenarioType: "gap", rawStory: story.trim(), targetRole: "C++ / C# <岗位>", personaStyle: "composed",
  });
  expect(hook.result.current.rawStory).toBe(story); expect(hook.result.current.targetRole).toBe("  C++ / C# <岗位>  ");
  expect(hook.result.current.scenarioType).toBe("gap"); expect(hook.result.current.personaStyle).toBe("composed");
  await act(async () => { pending.resolve({ id: 17 }); });
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/gap/17");
  act(() => { void hook.result.current.handleGenerate(); hook.result.current.setRawStory("导航新稿"); });
  expect(jsonFetch).toHaveBeenCalledOnce(); expect(hook.result.current.rawStory).toBe(story);
  expect(hook.result.current.submitting).toBe(true);
});

it.each([{}, { id: "7" }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, null, []].map(response => [response]))("无效完成响应 %j 保留原稿，刷新历史且不导航", async (response) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(response);
  const hook = prepared(); await act(() => hook.result.current.handleGenerate());
  expect(state.push).not.toHaveBeenCalled(); expect(hook.result.current.error).toContain("生成响应不完整");
  expect(hook.result.current.error).toContain("核对历史"); expect(hook.result.current.rawStory).toBe(story);
  expect(hook.result.current.submitting).toBe(false); expect(state.reload).toHaveBeenCalledOnce();
  vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 18 });
  await act(() => hook.result.current.handleGenerate());
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/gap/18"); expect(jsonFetch).toHaveBeenCalledTimes(2);
});

it("生成失败保留四项材料并只读刷新历史，显式重试仍提交原始限定", async () => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("synthetic upstream failure"));
  const hook = prepared(); await act(() => hook.result.current.handleGenerate());
  expect(hook.result.current.error).toContain("synthetic upstream failure");
  expect(hook.result.current.error).toContain("可能已经保存"); expect(state.reload).toHaveBeenCalledOnce();
  expect(hook.result.current.rawStory).toBe(story); expect(hook.result.current.submitting).toBe(false);
  expect(state.push).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledOnce();
});

it.each(["success", "failure"])("离页取消请求，旧 %s 不能导航、刷新或影响新页，保留的提交函数失效", async (mode) => {
  const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const original = prepared(); const start = original.result.current.handleGenerate;
  act(() => { void start(); });
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!;
  original.unmount(); expect(signal.aborted).toBe(true);
  const current = prepared();
  await act(async () => { await start(); if (mode === "success") pending.resolve({ id: 19 }); else pending.reject(new Error("old failure")); });
  expect(jsonFetch).toHaveBeenCalledOnce(); expect(state.push).not.toHaveBeenCalled(); expect(state.reload).not.toHaveBeenCalled();
  expect(current.result.current.rawStory).toBe(story); expect(current.result.current.submitting).toBe(false);
});

it("删除确认与生成从同事件开始互斥，取消后才能提交", async () => {
  const confirmation = Promise.withResolvers<boolean>(); state.confirm.mockReturnValueOnce(confirmation.promise);
  const hook = prepared();
  act(() => { void hook.result.current.removeRecord(7); void hook.result.current.handleGenerate(); });
  expect(jsonFetch).not.toHaveBeenCalled();
  await act(async () => { confirmation.resolve(false); });
  vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 20 }); await act(() => hook.result.current.handleGenerate());
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/gap/20");
});
