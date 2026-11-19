// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterviewSeries } from "../use-interview-series";
import type { SeriesData } from "../interview-series-types";
import { jsonFetch } from "@/lib/fetcher";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams("applicationId=42") }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const fetchMock = vi.mocked(jsonFetch);
const finalReport = { overall: 7.4, verdict: "仅据报告归纳", strengths: "分工明确", weaknesses: "上线待验证", suggestions: "核实记录" };
const finishedAt = "2026-10-28T00:00:00.000Z";
function series(id = 1, roundCount = 3): SeriesData {
  return { id, resume_title: `系列${id}`, jd: "岗位", rounds: 1, rounds_total: 3, status: "ongoing", created_at: "", finished_at: "", final_report: null,
    entries: Array.from({ length: roundCount }, (_, index) => ({ interview_id: id * 10 + index + 1, round_no: index + 1, style: "deep", status: "finished", rounds: 1, answered: 1,
      report: { depth: 7, structure: 8, authenticity: 8, completeness: 7, jd_match: 7, overall: 7.4, strengths: "已答", weaknesses: "待核实", suggestions: "核实记录" } })) };
}
function savedSeries(): SeriesData { return { ...series(), status: "finished", final_report: finalReport, finished_at: finishedAt }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(data = series()) {
  fetchMock.mockResolvedValueOnce(data);
  const hook = renderHook(() => useInterviewSeries(String(data.id)));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(data.id));
  return hook;
}
beforeEach(() => { fetchMock.mockReset(); push.mockReset(); });
afterEach(cleanup);

describe("系列总评与推进的保存恢复", () => {
  it("总评完整成功采用服务端时间，同步阻止连续命令且不额外读取", async () => {
    const { result } = await setup();
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.finalize(); void result.current.finalize(); void result.current.advance(); });
    expect(result.current.finalizing).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { response.resolve({ report: finalReport, finished_at: finishedAt }); await pending; });
    expect(result.current.data?.final_report).toEqual(finalReport);
    expect(result.current.data?.finished_at).toBe(finishedAt);
    expect(result.current.finalizing).toBe(false);
    await act(async () => { await result.current.finalize(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["响应丢失", "响应缺字段"])("总评%s 时读取存档恢复，不重复生成", async (mode) => {
    const { result } = await setup();
    if (mode === "响应丢失") fetchMock.mockRejectedValueOnce(new Error(mode));
    else fetchMock.mockResolvedValueOnce({ report: finalReport });
    fetchMock.mockResolvedValueOnce(savedSeries());
    await act(async () => { await result.current.finalize(); });
    expect(result.current.data?.final_report).toEqual(finalReport);
    expect(result.current.data?.finished_at).toBe(finishedAt);
    expect(result.current.actionError).toBe("");
    expect(fetchMock.mock.calls.slice(1)).toEqual([["/api/interviews/series/1/finalize", { method: "POST" }], ["/api/interviews/series/1"]]);
  });

  it("读取连续失败时只允许重读，重复恢复互斥，最终显示已保存总评", async () => {
    const { result } = await setup();
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockRejectedValueOnce(new Error("读取失败"));
    await act(async () => { await result.current.finalize(); });
    expect(result.current.readRecovery?.kind).toBe("finalize");
    expect(result.current.actionError).toContain("保存状态暂无法确认");
    await act(async () => { await result.current.finalize(); await result.current.advance(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockRejectedValueOnce(new Error("再次读取失败"));
    await act(async () => { await result.current.retryRead(); });
    expect(result.current.actionError).toContain("再次读取失败");
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.retryRead(); void result.current.retryRead(); void result.current.finalize(); });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await act(async () => { response.resolve(savedSeries()); await pending; });
    expect(result.current.data?.final_report).toEqual(finalReport);
    expect(result.current.readRecovery).toBeNull();
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

  it.each(["finalize", "advance"] as const)("%s 明确未保存时保留原错误并允许新提交", async (kind) => {
    const data = series(1, kind === "finalize" ? 3 : 1);
    const { result } = await setup(data);
    fetchMock.mockRejectedValueOnce(new Error("生成结果无效")).mockResolvedValueOnce(data);
    await act(async () => { await result.current[kind](); });
    expect(result.current.readRecovery).toBeNull();
    expect(result.current.actionError).toBe("生成结果无效");
    fetchMock.mockResolvedValueOnce(kind === "finalize" ? { report: finalReport, finished_at: finishedAt } : { id: 12, round_no: 2 });
    await act(async () => { await result.current[kind](); });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
  });

  it("推进响应丢失后恢复指定下一轮，不跳过已被别页完成的轮次，保留投递上下文", async () => {
    const { result } = await setup(series(1, 1));
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce(series(1, 3));
    await act(async () => { await result.current.advance(); });
    expect(push).toHaveBeenCalledExactlyOnceWith("/interviews/12?applicationId=42");
    expect(fetchMock).toHaveBeenCalledWith("/api/interviews/series/1/advance", {
      method: "POST", body: JSON.stringify({ from_interview_id: 11 }),
    });
    await act(async () => { await result.current.advance(); await result.current.finalize(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("下一轮响应错误、恢复失败后仅重读，成功时仅导航一次", async () => {
    const { result } = await setup(series(1, 1));
    fetchMock.mockResolvedValueOnce({ id: 13, round_no: 3 }).mockRejectedValueOnce(new Error("读取失败"));
    await act(async () => { await result.current.advance(); });
    expect(result.current.readRecovery?.kind).toBe("advance");
    expect(result.current.actionError).toContain("下一轮创建状态暂无法确认");
    expect(push).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(series(1, 2));
    await act(async () => { await result.current.retryRead(); });
    expect(push).toHaveBeenCalledExactlyOnceWith("/interviews/12?applicationId=42");
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

  it.each([
    { label: "错误实体", data: series(2) },
    { label: "缺总评字段", data: { ...series(), final_report: undefined } },
    { label: "损坏总评", data: { ...series(), final_report: {} } },
    { label: "缺完成时间", data: { ...savedSeries(), finished_at: "" } },
    { label: "重复轮次", data: { ...series(), entries: [series().entries[0], series().entries[0]] } },
    { label: "轮次缺口", data: { ...series(), entries: [series().entries[0], series().entries[2]] } },
    { label: "丢失全部原轮次", data: { ...series(), entries: [] } },
    { label: "丢失第三轮", data: series(1, 2) },
    { label: "同号轮次被替换", data: { ...series(), entries: series().entries.map((entry) => ({ ...entry, interview_id: entry.interview_id + 50 })) } },
  ])("恢复返回$label 时不放行生成", async ({ data }) => {
    const { result } = await setup();
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce(data);
    await act(async () => { await result.current.finalize(); });
    expect(result.current.readRecovery?.kind).toBe("finalize");
    expect(result.current.data?.final_report).toBeNull();
    await act(async () => { await result.current.finalize(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("系列页面的实体与请求隔离", () => {
  it.each(["成功", "失败"])("切换系列后旧加载%s 不覆盖新数据", async (mode) => {
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise).mockResolvedValueOnce(series(2));
    const { result, rerender } = renderHook(({ id }) => useInterviewSeries(id), { initialProps: { id: "1" } });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    await act(async () => { if (mode === "成功") response.resolve(series()); else response.reject(new Error("旧读取失败")); });
    expect(result.current.data?.id).toBe(2);
    expect(result.current.loadError).toBe("");
  });

  it.each(["finalize", "advance"] as const)("切换系列时清除旧数据，旧 %s 及保存的旧处理函数不生效", async (kind) => {
    const response = deferred<unknown>();
    const data = series(1, kind === "finalize" ? 3 : 1);
    fetchMock.mockResolvedValueOnce(data);
    const { result, rerender } = renderHook(({ id }) => useInterviewSeries(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    fetchMock.mockReturnValueOnce(response.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current[kind](); });
    const old = result.current;
    const loadB = deferred<unknown>();
    fetchMock.mockReturnValueOnce(loadB.promise);
    rerender({ id: "2" });
    expect(result.current.data).toBeNull();
    expect(result.current.finalizing).toBe(false);
    expect(result.current.advancing).toBe(false);
    await act(async () => { await result.current.finalize(); await old[kind](); response.resolve(kind === "finalize" ? { report: finalReport, finished_at: finishedAt } : { id: 12, round_no: 2 }); await pending; });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(push).not.toHaveBeenCalled();
    await act(async () => { loadB.resolve(series(2)); });
    expect(result.current.data?.id).toBe(2);
    expect(result.current.data?.final_report).toBeNull();
  });

  it("旧恢复读取的结果不能覆盖新系列或清除新系列在途状态", async () => {
    fetchMock.mockResolvedValueOnce(series());
    const { result, rerender } = renderHook(({ id }) => useInterviewSeries(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    const readA = deferred<unknown>();
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockReturnValueOnce(readA.promise);
    let pendingA!: Promise<void>;
    await act(async () => { pendingA = result.current.finalize(); });
    fetchMock.mockResolvedValueOnce(series(2));
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    const postB = deferred<unknown>();
    fetchMock.mockReturnValueOnce(postB.promise);
    let pendingB!: Promise<void>;
    act(() => { pendingB = result.current.finalize(); });
    await act(async () => { readA.resolve(savedSeries()); await pendingA; });
    expect(result.current.finalizing).toBe(true);
    expect(result.current.data?.id).toBe(2);
    await act(async () => { postB.resolve({ report: finalReport, finished_at: finishedAt }); await pendingB; });
  });

  it("初始加载失败可重试；StrictMode 下只接受当前读取，已有总评不再生成", async () => {
    fetchMock.mockRejectedValue(new Error("读取失败"));
    const { result } = renderHook(() => useInterviewSeries("1"), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.loadError).toBe("读取失败"));
    fetchMock.mockResolvedValue(savedSeries());
    act(() => { result.current.retryLoad(); });
    await waitFor(() => expect(result.current.data?.final_report).toEqual(finalReport));
    expect(result.current.loadError).toBe("");
    await act(async () => { await result.current.finalize(); await result.current.advance(); });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
  });

  it("卸载后的失败不发起额外读取或导航", async () => {
    const { result, unmount } = await setup(series(1, 1));
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.advance(); });
    unmount();
    await act(async () => { response.reject(new Error("晚到失败")); await pending; });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(push).not.toHaveBeenCalled();
  });
});
