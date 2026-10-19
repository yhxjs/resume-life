// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterviewCommands, type InterviewData } from "../use-interview-session";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse, type SseOptions } from "@/lib/fetch-sse";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { StrictMode } from "react";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }), useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function interview(id: number): InterviewData {
  return {
    id, resume_title: `面试${id}`, jd: "", rounds: 2, style: "technical",
    series_id: id + 10, round_no: 1, series_status: "active", series_rounds: [],
    status: "ongoing", report: null, evaluator_report: null, reverse_interview: null,
    created_at: "", finished_at: "",
    turns: [{ id: id * 100, idx: 1, kind: "technical", question: "问题", answer: "", comment: "", scores: null, reference: "", retries: [], answered_at: "", notebook_id: null }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(100), 10));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("面试命令的实体隔离", () => {
  it("A 切换至 B 且 B 读取未完成时清除 A 状态并拒绝提交", async () => {
    const loadB = deferred<InterviewData>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockReturnValueOnce(loadB.promise);
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => { result.current.setAnswer("A 的回答"); result.current.handleStartReverse(); });
    const oldCommands = result.current;
    rerender({ id: "2" });
    await act(async () => {
      await result.current.submitAnswer(); await result.current.generateReportDirectly(); await result.current.handleSubmitReverse("旧问题");
      await oldCommands.submitAnswer(); await oldCommands.generateReportDirectly();
      oldCommands.setData(interview(1));
    });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(fetchSse).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
    expect(result.current.answer).toBe("");
    expect(result.current.showReverseInputModal).toBe(false);
    await act(async () => { loadB.resolve(interview(2)); });
    expect(result.current.data?.id).toBe(2);
  });

  it("A 报告命令的延迟读取不能覆盖 B 或清除 B 的 busy", async () => {
    const finishA = deferred<unknown>();
    const refreshA = deferred<InterviewData>();
    const finishB = deferred<unknown>();
    vi.mocked(jsonFetch).mockImplementation((url) => {
      if (url === "/api/interviews/1/finish") return finishA.promise;
      if (url === "/api/interviews/2/finish") return finishB.promise;
      if (url === "/api/interviews/1") return vi.mocked(jsonFetch).mock.calls.filter(([path]) => path === url).length === 1 ? Promise.resolve(interview(1)) : refreshA.promise;
      return Promise.resolve(interview(2));
    });
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    let commandA!: Promise<void>;
    act(() => { commandA = result.current.generateReportDirectly(); });
    await act(async () => { finishA.resolve({ ok: true }); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    let commandB!: Promise<void>;
    act(() => { commandB = result.current.generateReportDirectly(); });
    await act(async () => { refreshA.resolve(interview(1)); await commandA; });
    expect(result.current.data?.id).toBe(2);
    expect(result.current.busy).toBe(true);
    await act(async () => { finishB.resolve({ ok: true }); await commandB; });
  });

  it("A 的过期 SSE 事件不写入 B 的文字、错误、反问弹窗或回答", async () => {
    const streamA = deferred<void>();
    let events!: SseOptions<{ natural_finished?: boolean }>;
    vi.mocked(fetchSse).mockImplementation((_url, options) => { events = options; return streamA.promise; });
    vi.mocked(jsonFetch).mockImplementation((url) => Promise.resolve(interview(url.endsWith("/1") ? 1 : 2)));
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => { result.current.setAnswer("A 回答"); });
    let commandA!: Promise<void>;
    act(() => { commandA = result.current.submitAnswer(); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    act(() => { result.current.setAnswer("B 回答"); });
    await act(async () => {
      events.onDelta?.("A 反馈");
      events.onError?.(new Error("A 错误"));
      await events.onDone?.({ natural_finished: true });
      streamA.resolve(); await commandA;
    });
    expect(result.current.data?.id).toBe(2);
    expect(result.current.answer).toBe("B 回答");
    expect(result.current.error).toBe("");
    expect(result.current.answerTypewriter.displayedText).toBe("");
    expect(result.current.showReverseChoiceModal).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it.each(["reverse", "remediation", "advance"])("A 的 %s 延迟完成不能覆盖 B 或导航离开 B", async (command) => {
    const pending = deferred<{ id: number }>();
    vi.mocked(jsonFetch).mockImplementation((url, init) => init?.method === "POST" ? pending.promise : Promise.resolve(interview(url.endsWith("/1") ? 1 : 2)));
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    let action!: Promise<void>;
    act(() => { action = command === "reverse" ? result.current.handleSubmitReverse("A 提问") : command === "remediation" ? result.current.startRemediation() : result.current.advance(); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    await act(async () => { pending.resolve({ id: 50 }); await action; });
    expect(result.current.data?.id).toBe(2);
    expect(push).not.toHaveBeenCalled();
    expect(result.current.reverseBusy).toBe(false);
    expect(result.current.remediating).toBe(false);
    expect(result.current.advancing).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it("A 的提前结束确认在切换 B 后不会提交旧命令", async () => {
    const confirmed = deferred<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(confirmed.promise);
    vi.mocked(jsonFetch).mockImplementation((url) => Promise.resolve(interview(url.endsWith("/1") ? 1 : 2)));
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    let finish!: Promise<void>;
    act(() => { finish = result.current.finish(); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    await act(async () => { confirmed.resolve(true); await finish; });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("当前实体的作答仍接收反馈、刷新数据并显示自然结束选择", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(interview(1));
    vi.mocked(fetchSse).mockImplementation(async (_url, options) => {
      options.onDelta?.("当前反馈");
      await options.onDone?.({ natural_finished: true });
    });
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => { result.current.setAnswer("当前回答"); });
    await act(async () => { await result.current.submitAnswer(); });
    expect(fetchSse).toHaveBeenCalledWith("/api/interviews/1/answer", expect.objectContaining({ body: { turn_id: 100, answer: "当前回答" } }));
    expect(result.current.answerTypewriter.displayedText).toBe("当前反馈");
    expect(result.current.answer).toBe("");
    expect(result.current.busy).toBe(false);
    expect(result.current.showReverseChoiceModal).toBe(true);
  });

  it.each(["reverse", "remediation", "advance"])("当前实体的 %s 成功行为保持有效", async (command) => {
    vi.mocked(jsonFetch).mockImplementation((_url, init) => Promise.resolve(init?.method === "POST" ? { id: 50 } : interview(1)));
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    await act(async () => {
      if (command === "reverse") await result.current.handleSubmitReverse("当前提问");
      else if (command === "remediation") await result.current.startRemediation();
      else await result.current.advance();
    });
    if (command === "reverse") {
      expect(result.current.data?.id).toBe(1);
      expect(result.current.reverseBusy).toBe(false);
      expect(jsonFetch).toHaveBeenCalledTimes(3);
    } else expect(push).toHaveBeenCalledWith(command === "remediation" ? "/drills/50" : "/interviews/50");
  });

  it("StrictMode 重播 effect 后仍正常加载和提交", async () => {
    vi.mocked(jsonFetch).mockResolvedValue(interview(1));
    const { result } = renderHook(() => useInterviewCommands("1"), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    await act(async () => { await result.current.generateReportDirectly(); });
    expect(jsonFetch).toHaveBeenCalledWith("/api/interviews/1/finish", { method: "POST" });
    expect(result.current.busy).toBe(false);
  });

  it("A→B→A 不会重新接纳第一世代 A 的完成或错误", async () => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockImplementation((url, init) => init?.method === "POST" ? pending.promise : Promise.resolve(interview(url.endsWith("/1") ? 1 : 2)));
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    let old!: Promise<void>;
    act(() => { old = result.current.generateReportDirectly(); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    rerender({ id: "1" });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    await act(async () => { pending.reject(new Error("旧 A 失败")); await old; });
    expect(result.current.error).toBe("");
    expect(result.current.busy).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(4);
  });
});
