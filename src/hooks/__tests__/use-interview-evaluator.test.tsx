// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterviewEvaluator } from "../use-interview-evaluator";
import { jsonFetch } from "@/lib/fetcher";
import type { EvaluatorReport } from "@/lib/scores";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const fetchMock = vi.mocked(jsonFetch);
const saved: EvaluatorReport = {
  recommendation: "Hire", level: "暂无法判断", level_justification: "证据不足", summary_for_hr: "职责明确",
  hire_reasons: [], concerns_and_risks: [], placement_suggestion: "补充考察", evidence_quotes: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => fetchMock.mockReset());
afterEach(cleanup);

describe("独立面试评估的提交与恢复", () => {
  it("同步互斥阻止连续生成，完整成功响应可独立展示，不额外 GET", async () => {
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    const onReportGenerated = vi.fn();
    const { result } = renderHook(() => useInterviewEvaluator({ interviewId: 1, report: null, onReportGenerated }), { wrapper: StrictMode });
    let pending!: Promise<void>;
    act(() => { pending = result.current.generate(); void result.current.generate(); });
    expect(result.current.generating).toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/interviews/1/evaluator-report", { method: "POST" });
    await act(async () => { response.resolve({ evaluator_report: saved }); await pending; });
    expect(result.current.report).toEqual(saved);
    expect(result.current.generating).toBe(false);
    expect(onReportGenerated).toHaveBeenCalledExactlyOnceWith(saved);
    await act(async () => { await result.current.generate(); await result.current.retryRead(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["丢失响应", "非法响应"])("%s 时先 GET，恢复已保存评估且不再生成", async (mode) => {
    if (mode === "丢失响应") fetchMock.mockRejectedValueOnce(new Error("连接断开"));
    else fetchMock.mockResolvedValueOnce({ evaluator_report: {} });
    fetchMock.mockResolvedValueOnce({ id: 1, evaluator_report: saved });
    const onReportGenerated = vi.fn();
    const { result } = renderHook(() => useInterviewEvaluator({ interviewId: 1, report: null, onReportGenerated }));
    await act(async () => { await result.current.generate(); });
    expect(fetchMock.mock.calls).toEqual([["/api/interviews/1/evaluator-report", { method: "POST" }], ["/api/interviews/1"]]);
    expect(result.current.report).toEqual(saved);
    expect(result.current.error).toBe("");
    expect(result.current.readRecovery).toBe(false);
    expect(onReportGenerated).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("多次读取失败后仅允许 GET，重读同步互斥，确认保存后完成", async () => {
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockRejectedValueOnce(new Error("读取失败"));
    const onReportGenerated = vi.fn();
    const { result } = renderHook(() => useInterviewEvaluator({ interviewId: 1, report: null, onReportGenerated }));
    await act(async () => { await result.current.generate(); });
    expect(result.current.error).toContain("保存状态暂无法确认");
    expect(result.current.readRecovery).toBe(true);
    await act(async () => { await result.current.generate(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRejectedValueOnce(new Error("再次读取失败"));
    await act(async () => { await result.current.retryRead(); });
    expect(result.current.error).toContain("再次读取失败");
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.retryRead(); void result.current.retryRead(); void result.current.generate(); });
    expect(result.current.generating).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => { response.resolve({ id: 1, evaluator_report: saved }); await pending; });
    expect(result.current.report).toEqual(saved);
    expect(onReportGenerated).toHaveBeenCalledExactlyOnceWith(saved);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

  it("明确读到未保存时恢复生成入口，保留原失败原因", async () => {
    fetchMock.mockRejectedValueOnce(new Error("模型输出无效")).mockResolvedValueOnce({ id: 1, evaluator_report: null });
    const { result } = renderHook(() => useInterviewEvaluator({ interviewId: 1, report: null }));
    await act(async () => { await result.current.generate(); });
    expect(result.current.error).toBe("模型输出无效");
    expect(result.current.readRecovery).toBe(false);
    expect(result.current.report).toBeNull();
    fetchMock.mockResolvedValueOnce({ evaluator_report: saved });
    await act(async () => { await result.current.generate(); });
    expect(result.current.report).toEqual(saved);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(2);
  });

  it.each([
    { id: 2, evaluator_report: saved },
    { id: 1 },
    { id: 1, evaluator_report: {} },
    { id: 1, evaluator_report: "" },
  ])("错误实体或不完整读取 %j 不当作未保存、不放行 POST", async (data) => {
    fetchMock.mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce(data);
    const { result } = renderHook(() => useInterviewEvaluator({ interviewId: 1, report: null }));
    await act(async () => { await result.current.generate(); });
    expect(result.current.readRecovery).toBe(true);
    expect(result.current.error).toContain("保存状态暂无法确认");
    expect(result.current.report).toBeNull();
    await act(async () => { await result.current.generate(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["生成成功", "生成失败", "读取成功", "读取失败"])("切换实体后，旧%s 不更新新页或触发旧回调", async (mode) => {
    const response = deferred<unknown>();
    if (mode.startsWith("读取")) fetchMock.mockRejectedValueOnce(new Error("响应丢失"));
    fetchMock.mockReturnValueOnce(response.promise);
    const onReportGenerated = vi.fn();
    const { result, rerender } = renderHook(({ id }) => useInterviewEvaluator({ interviewId: id, report: null, onReportGenerated }), { initialProps: { id: 1 } });
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.generate(); });
    rerender({ id: 2 });
    expect(result.current.report).toBeNull();
    expect(result.current.generating).toBe(false);
    expect(result.current.readRecovery).toBe(false);
    await act(async () => {
      if (mode.endsWith("成功")) response.resolve({ id: 1, evaluator_report: saved });
      else response.reject(new Error("旧错误"));
      await pending;
    });
    expect(result.current.report).toBeNull();
    expect(result.current.error).toBe("");
    expect(onReportGenerated).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(mode.startsWith("读取") ? 2 : 1);
    fetchMock.mockResolvedValueOnce({ evaluator_report: { ...saved, summary_for_hr: "新页评估" } });
    await act(async () => { await result.current.generate(); });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/interviews/2/evaluator-report", { method: "POST" });
    expect(result.current.report?.summary_for_hr).toBe("新页评估");
  });

  it("卸载后晚到的成功不回调，已有评估不生成", async () => {
    const response = deferred<unknown>();
    fetchMock.mockReturnValueOnce(response.promise);
    const onReportGenerated = vi.fn();
    const { result, unmount } = renderHook(() => useInterviewEvaluator({ interviewId: 1, report: null, onReportGenerated }));
    let pending!: Promise<void>;
    act(() => { pending = result.current.generate(); });
    unmount();
    await act(async () => { response.resolve({ evaluator_report: saved }); await pending; });
    expect(onReportGenerated).not.toHaveBeenCalled();
    const existing = renderHook(() => useInterviewEvaluator({ interviewId: 1, report: saved }));
    await act(async () => { await existing.result.current.generate(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existing.result.current.report).toBe(saved);
  });
});
