// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterviewSeriesActions } from "../use-interview-series-actions";
import type { SeriesData } from "../interview-series-types";
import { jsonFetch } from "@/lib/fetcher";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams("applicationId=42") }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const fetchMock = vi.mocked(jsonFetch);
const isCurrent = () => true;
const initialProps = { interviewId: 11, seriesId: 1, roundNo: 1, isCurrent };
function series(count = 2): SeriesData {
  return { id: 1, resume_title: "系列", jd: "岗位", rounds: 1, rounds_total: 3, status: "ongoing", created_at: "", finished_at: "", final_report: null,
    entries: Array.from({ length: count }, (_, index) => ({ interview_id: 11 + index, round_no: index + 1, style: "deep", status: "finished", rounds: 1, answered: 1,
      report: { depth: 7, structure: 8, authenticity: 8, completeness: 7, jd_match: 7, overall: 7.4, strengths: "已答", weaknesses: "待核实", suggestions: "核实记录" } })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() { return renderHook((props) => useInterviewSeriesActions(props), { initialProps }); }
beforeEach(() => { fetchMock.mockReset(); push.mockReset(); });
afterEach(cleanup);

describe("详情页推进下一轮的恢复与导航互斥", () => {
  it("成功响应直接导航并保留投递上下文，连续命令只发送一次", async () => {
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    const { result } = setup();
    let pending!: Promise<void>;
    act(() => { pending = result.current.advance(); void result.current.advance(); void result.current.startRemediation(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.advancing).toBe(true);
    await act(async () => { response.resolve({ id: 12, round_no: 2 }); await pending; });
    expect(push).toHaveBeenCalledWith("/interviews/12?applicationId=42");
    await act(async () => { await result.current.advance(); await result.current.startRemediation(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["响应丢失", "缺字段", "错轮次", "非法ID", "原面试ID"])("%s 后按原目标轮次恢复，不跳到其他页面已创建的第三轮", async (mode) => {
    if (mode === "响应丢失") fetchMock.mockRejectedValueOnce(new Error(mode));
    else fetchMock.mockResolvedValueOnce(mode === "缺字段" ? { id: 12 } : mode === "错轮次" ? { id: 13, round_no: 3 } : { id: mode === "原面试ID" ? 11 : -1, round_no: 2 });
    fetchMock.mockResolvedValueOnce(series(3));
    const { result } = setup();
    await act(async () => { await result.current.advance(); });
    expect(push).toHaveBeenCalledExactlyOnceWith("/interviews/12?applicationId=42");
    expect(result.current.readRecovery).toBeNull();
    expect(result.current.advanceError).toBe("");
    expect(fetchMock.mock.calls).toEqual([["/api/interviews/series/1/advance", { method: "POST", body: JSON.stringify({ from_interview_id: 11 }) }], ["/api/interviews/series/1"]]);
  });

  it("读取失败只允许重读，恢复按钮连点也只 GET 一次", async () => {
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockRejectedValueOnce(new Error("读取失败"));
    const { result } = setup();
    await act(async () => { await result.current.advance(); });
    expect(result.current.advanceError).toContain("下一轮创建状态暂无法确认");
    expect(result.current.readRecovery?.roundNo).toBe(2);
    expect(result.current.advancing).toBe(false);
    await act(async () => { await result.current.advance(); await result.current.startRemediation(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const response = deferred<SeriesData>();
    fetchMock.mockReturnValueOnce(response.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.retryRead(); void result.current.retryRead(); void result.current.advance(); });
    expect(result.current.advancing).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { response.reject(new Error("再次失败")); await pending; });
    expect(result.current.advanceError).toContain("再次失败");
    fetchMock.mockResolvedValueOnce(series());
    await act(async () => { await result.current.retryRead(); });
    expect(push).toHaveBeenCalledExactlyOnceWith("/interviews/12?applicationId=42");
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it.each(["错误实体", "原记录缺失", "原记录替换", "轮次重复", "报告损坏", "字段缺失"])("%s 不能当作尚未保存，继续只读恢复", async (mode) => {
    const invalid = series();
    if (mode === "错误实体") invalid.id = 2;
    if (mode === "原记录缺失") invalid.entries = [];
    if (mode === "原记录替换") invalid.entries[0]!.interview_id = 99;
    if (mode === "轮次重复") invalid.entries[1]!.round_no = 1;
    if (mode === "报告损坏") invalid.entries[0]!.report = {} as never;
    if (mode === "字段缺失") delete (invalid as Partial<SeriesData>).final_report;
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce(invalid);
    const { result } = setup();
    await act(async () => { await result.current.advance(); await result.current.advance(); });
    expect(result.current.readRecovery).not.toBeNull();
    expect(result.current.advanceError).toContain("状态暂无法确认");
    expect(push).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("明确没有目标轮次才恢复推进入口，并保留原提交错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("生成失败")).mockResolvedValueOnce(series(1)).mockResolvedValueOnce({ id: 12, round_no: 2 });
    const { result } = setup();
    await act(async () => { await result.current.advance(); });
    expect(result.current.readRecovery).toBeNull();
    expect(result.current.advanceError).toBe("生成失败");
    expect(result.current.advancing).toBe(false);
    await act(async () => { await result.current.advance(); });
    expect(push).toHaveBeenCalledOnce();
  });

  it.each(["成功", "失败", "读取中"])("切换实体后，旧请求%s 与旧处理函数不导航也不清除新请求", async (mode) => {
    const response = deferred<unknown>();
    if (mode === "读取中") fetchMock.mockRejectedValueOnce(new Error("丢失"));
    fetchMock.mockReturnValueOnce(response.promise);
    const { result, rerender } = setup();
    const old = result.current;
    let pending!: Promise<void>;
    await act(async () => { pending = old.advance(); });
    rerender({ ...initialProps, interviewId: 21, seriesId: 2 });
    const nextResponse = deferred<unknown>();
    fetchMock.mockReturnValueOnce(nextResponse.promise);
    let next!: Promise<void>;
    act(() => { next = result.current.advance(); });
    await act(async () => {
      if (mode === "失败") response.reject(new Error("旧失败"));
      else response.resolve(mode === "读取中" ? series() : { id: 12, round_no: 2 });
      await pending;
      await old.advance(); await old.retryRead(); await old.startRemediation();
    });
    expect(push).not.toHaveBeenCalled();
    expect(result.current.advancing).toBe(true);
    expect(result.current.advanceError).toBe("");
    expect(result.current.readRecovery).toBeNull();
    await act(async () => { nextResponse.resolve({ id: 22, round_no: 2 }); await next; });
    expect(push).toHaveBeenCalledExactlyOnceWith("/interviews/22?applicationId=42");
  });

  it("卸载后失败不再读取或导航", async () => {
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    const { result, unmount } = setup();
    let pending!: Promise<void>;
    act(() => { pending = result.current.advance(); });
    unmount();
    await act(async () => { response.reject(new Error("旧请求失败")); await pending; });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("追练导航占锁，失败后可以推进下一轮", async () => {
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    const { result } = setup();
    let pending!: Promise<void>;
    act(() => { pending = result.current.startRemediation(); void result.current.startRemediation(); void result.current.advance(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { response.reject(new Error("追练失败")); await pending; });
    expect(result.current.remediating).toBe(false);
    expect(result.current.remedialError).toBe("追练失败");
    fetchMock.mockResolvedValueOnce({ id: 12, round_no: 2 });
    await act(async () => { await result.current.advance(); });
    expect(push).toHaveBeenCalledOnce();
  });

  it("StrictMode 重放后正常恢复", async () => {
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce(series());
    const { result } = renderHook(() => useInterviewSeriesActions(initialProps), { wrapper: StrictMode });
    await act(async () => { await result.current.advance(); });
    expect(push).toHaveBeenCalledOnce();
  });
});
