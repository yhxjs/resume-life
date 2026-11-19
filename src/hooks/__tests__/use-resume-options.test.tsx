// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { jsonFetch } from "@/lib/fetcher";
import { useResumeOptions } from "../use-resume-options";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const first = { id: 1, title: "原始 <T> &amp; 标题", updated_at: "", versions: [{ id: 11, version: 1, name: "发布旧版 <V>" }] };
const second = { id: 2, title: "另一份简历", updated_at: "", versions: [{ id: 21, version: 1, name: "另一版" }] };
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); });
afterEach(cleanup);

it("完整校验历史编号，候选仅保留可绑定的草稿与版本", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce([
    { ...second, id: 0, versions: [] }, { ...second, id: -7, versions: [] },
    { ...first, versions: [...first.versions, { id: -3, version: 2, name: "历史版" }] },
  ]);
  const { result } = renderHook(() => useResumeOptions());
  await waitFor(() => expect(result.current.resumes).toEqual([first]));
  expect(result.current.resumesError).toBe("");
});

it.each([
  null, {}, [null], [{ ...first, id: "1" }], [{ ...first, id: 1.5 }],
  [{ ...first, id: Number.MAX_SAFE_INTEGER + 1 }], [{ ...first, title: null }], [{ ...first, updated_at: 1 }],
  [{ ...first, versions: undefined }], [{ ...first, versions: null }],
  [{ ...first, versions: [null] }], [{ ...first, versions: [{ id: "11", version: 1, name: "版" }] }],
  [{ ...first, versions: [{ id: 11, version: 0, name: "版" }] }],
  [{ ...first, versions: [{ id: 11, version: 1.5, name: "版" }] }],
  [{ ...first, versions: [{ id: 11, version: 1, name: null }] }],
  [first, first], [{ ...first, versions: [first.versions[0], first.versions[0]] }],
  [{ ...first, versions: [first.versions[0], { id: 12, version: 1, name: "重复编号" }] }],
  [first, { ...second, versions: [{ id: 11, version: 1, name: "跨简历重复" }] }],
  [{ ...first, versions: [{ ...first.versions[0], resume_id: 2 }] }],
])("异常候选响应 %# 整体拒绝，初次失败不暴露错误选项", async (response) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(response);
  const view = renderHook(() => useResumeOptions());
  await waitFor(() => expect(view.result.current.resumesError).toContain("简历列表响应"));
  expect(view.result.current.resumes).toBeNull();
});

it("正常空列表、未发布简历和历史长文本完整保留，不裁剪重排或补造字段", async () => {
  const rows = [second, { id: 3, title: "历史_".repeat(300), versions: [] }, first];
  vi.mocked(jsonFetch).mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
  const view = renderHook(() => useResumeOptions());
  await waitFor(() => expect(view.result.current.resumes).toEqual(rows));
  expect(view.result.current.resumesError).toBe("");
  act(() => view.result.current.reloadResumes());
  await waitFor(() => expect(view.result.current.resumes).toEqual([]));
});

it("刷新失败或响应损坏保留已验证选项，后续重读可恢复", async () => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockResolvedValueOnce([first]).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([second]);
  const view = renderHook(() => useResumeOptions());
  await waitFor(() => expect(view.result.current.resumes).toEqual([first]));
  act(() => view.result.current.reloadResumes());
  expect(view.result.current.resumes).toEqual([first]);
  await act(async () => pending.resolve([first, { ...second, versions: {} }]));
  expect(view.result.current.resumes).toEqual([first]);
  expect(view.result.current.resumesError).toContain("简历列表响应");
  act(() => view.result.current.reloadResumes());
  await waitFor(() => expect(view.result.current.resumes).toEqual([second]));
  expect(view.result.current.resumesError).toBe("");
});

it.each(["成功", "失败"])("同步重读即中止并作废旧请求，旧%s不影响新读取", async (outcome) => {
  const old = Promise.withResolvers<unknown>();
  const current = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const view = renderHook(() => useResumeOptions());
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  act(() => {
    view.result.current.reloadResumes();
    expect(signal?.aborted).toBe(true);
  });
  await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
  await act(async () => {
    if (outcome === "成功") old.resolve([first]);
    else old.reject(new Error("旧读取失败"));
  });
  expect(view.result.current.resumes).toBeNull();
  expect(view.result.current.resumesError).toBe("");
  await act(async () => current.resolve([second]));
  expect(view.result.current.resumes).toEqual([second]);
  expect(jsonFetch).toHaveBeenCalledWith("/api/resumes", expect.objectContaining({ signal: expect.any(AbortSignal), cache: "no-store" }));
});

it("外部刷新键变化中止旧读取，不让它覆盖已读新选项", async () => {
  const old = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce([second]);
  const view = renderHook(({ key }) => useResumeOptions(key), { initialProps: { key: 1 } });
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  view.rerender({ key: 2 });
  expect(signal?.aborted).toBe(true);
  await waitFor(() => expect(view.result.current.resumes).toEqual([second]));
  await act(async () => old.resolve([first]));
  expect(view.result.current.resumes).toEqual([second]);
});

it.each(["成功", "失败"])("离页后旧%s和保留的重读入口均失效", async (outcome) => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const view = renderHook(() => useResumeOptions());
  const reload = view.result.current.reloadResumes;
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    reload();
    if (outcome === "成功") pending.resolve([first]);
    else pending.reject(new Error("离页旧失败"));
  });
  expect(jsonFetch).toHaveBeenCalledTimes(1);
});

it("StrictMode 重挂载只接受当前读取，不让旧请求关闭或覆盖新结果", async () => {
  const old = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce([second]);
  const view = renderHook(() => useResumeOptions(), { reactStrictMode: true });
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(view.result.current.resumes).toEqual([second]));
  expect(vi.mocked(jsonFetch).mock.calls[0]![1]?.signal?.aborted).toBe(true);
  await act(async () => old.resolve([first]));
  expect(view.result.current.resumes).toEqual([second]);
});
