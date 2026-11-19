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

function savedAnswer(answer: string, finished = false): InterviewData {
  const saved = interview(1);
  saved.turns[0] = { ...saved.turns[0]!, answer: answer.trim(), answered_at: "saved", comment: "已保存点评" };
  if (finished) saved.status = "finished";
  else saved.turns.push({ ...interview(1).turns[0]!, id: 101, idx: 2, question: "下一题" });
  return saved;
}

function savedReport(): InterviewData {
  return { ...savedAnswer("原答", true), report: {
    depth: 7, structure: 8, authenticity: 8, completeness: 7, overall: 7.5, jd_match: 7,
    strengths: "分工明确", weaknesses: "验证待核实", suggestions: "核实记录",
  } };
}

function savedReverse(): InterviewData {
  return { ...interview(1), status: "finished", reverse_interview: {
    question: "当前提问", answer: "模拟回答：团队情况待核实", created_at: "saved",
    evaluation: { score: 8, level: "优秀", insight: "关注岗位信息", feedback: "提问具体", suggestions: "向招聘方核实" },
  } };
}

const reportReceipt = (id = 1) => ({ interview_id: id, report: savedReport().report, evaluator_report: null, finished_at: "saved" });
const reverseReceipt = (question = "当前提问") => ({ interview_id: 1, ok: true, reverse: { ...savedReverse().reverse_interview!, question } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jsonFetch).mockReset(); vi.mocked(fetchSse).mockReset(); vi.mocked(confirmDialog).mockReset();
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
    await act(async () => { finishA.resolve(reportReceipt()); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    let commandB!: Promise<void>;
    act(() => { commandB = result.current.generateReportDirectly(); });
    await act(async () => { refreshA.resolve(interview(1)); await commandA; });
    expect(result.current.data?.id).toBe(2);
    expect(result.current.busy).toBe(true);
    await act(async () => { finishB.resolve(reportReceipt(2)); await commandB; });
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
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockResolvedValue(savedAnswer("当前回答", true));
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
    vi.mocked(jsonFetch).mockImplementation((_url, init) => Promise.resolve(init?.method === "POST" ? (command === "reverse" ? reverseReceipt() : { id: 50, round_no: 2 })
      : command === "reverse" && vi.mocked(jsonFetch).mock.calls.length > 1 ? savedReverse() : interview(1)));
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
      expect(result.current.reverseReadRecovery).toBeNull();
      expect(result.current.reverseError).toBe("");
      expect(result.current.data?.reverse_interview?.answer).toContain("模拟回答");
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

describe("反问提交与读取恢复", () => {
  it.each([false, true])("保留反问弹窗，读取失败只重读并阻止重复提交或生成报告（响应丢失=%s）", async (lost) => {
    const post = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockReturnValueOnce(post.promise)
      .mockRejectedValueOnce(new Error("读取失败"))
      .mockRejectedValueOnce(new Error("再次读取失败"))
      .mockResolvedValueOnce(savedReverse());
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.handleStartReverse());
    let submit!: Promise<void>;
    act(() => { submit = result.current.handleSubmitReverse("当前提问"); });
    await act(async () => {
      await result.current.handleSubmitReverse("重复提问");
      await result.current.generateReportDirectly();
      await result.current.handleSkipReverse();
      result.current.setShowReverseInputModal(false);
    });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(result.current.showReverseInputModal).toBe(true);
    await act(async () => {
      if (lost) post.reject(new Error("响应丢失")); else post.resolve(reverseReceipt());
      await submit;
    });
    expect(result.current.reverseBusy).toBe(false);
    expect(result.current.showReverseInputModal).toBe(true);
    expect(result.current.reverseReadRecovery?.confirmed).toBe(!lost);
    expect(result.current.reverseError).toContain(lost ? "保存状态暂无法确认" : "反问已保存，读取结果失败");
    await act(async () => {
      await result.current.handleSubmitReverse("重复提问");
      await result.current.generateReportDirectly();
      await result.current.handleSkipReverse();
      result.current.setShowReverseInputModal(false);
    });
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { await result.current.retryReverseRead(); });
    expect(result.current.reverseError).toContain("再次读取失败");
    expect(result.current.showReverseInputModal).toBe(true);
    await act(async () => { await result.current.retryReverseRead(); });
    expect(result.current.reverseReadRecovery).toBeNull();
    expect(result.current.showReverseInputModal).toBe(false);
    expect(result.current.reverseError).toBe("");
    expect(result.current.data?.reverse_interview?.question).toBe("当前提问");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("提交失败但确认未保存时保留弹窗与原错误，允许修改问题后重试", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockRejectedValueOnce(new Error("模型暂不可用"))
      .mockResolvedValueOnce(interview(1)).mockResolvedValueOnce(reverseReceipt()).mockResolvedValueOnce(savedReverse());
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.handleStartReverse());
    await act(async () => { await result.current.handleSubmitReverse("第一次提问"); });
    expect(result.current.showReverseInputModal).toBe(true);
    expect(result.current.reverseReadRecovery).toBeNull();
    expect(result.current.reverseError).toBe("模型暂不可用");
    await act(async () => { await result.current.handleSubmitReverse("当前提问"); });
    expect(result.current.showReverseInputModal).toBe(false);
    expect(jsonFetch).toHaveBeenCalledWith("/api/interviews/1/reverse", expect.objectContaining({ body: JSON.stringify({ question: "当前提问" }) }));
  });

  it.each(["missing", "wrong-id", "incomplete"])("已确认保存后%s结果继续等待，只读重试不重新生成", async (invalid) => {
    const bad = invalid === "missing" ? interview(1) : invalid === "wrong-id" ? interview(2)
      : { ...interview(1), reverse_interview: { question: "只有问题" } };
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockResolvedValueOnce(reverseReceipt())
      .mockResolvedValueOnce(bad).mockResolvedValueOnce(savedReverse());
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.handleStartReverse());
    await act(async () => { await result.current.handleSubmitReverse("当前提问"); });
    expect(result.current.reverseReadRecovery?.confirmed).toBe(true);
    expect(result.current.data?.reverse_interview).toBeNull();
    await act(async () => { await result.current.retryReverseRead(); });
    expect(result.current.reverseReadRecovery).toBeNull();
    expect(result.current.data?.reverse_interview?.question).toBe("当前提问");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("作答或报告在途时，旧反问入口不能打开或提交", async () => {
    const report = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockReturnValueOnce(report.promise).mockResolvedValue(savedReport());
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    const old = result.current;
    let pending!: Promise<void>;
    act(() => { pending = result.current.generateReportDirectly(); });
    await act(async () => { old.handleStartReverse(); await old.handleSubmitReverse("旧反问"); });
    expect(result.current.showReverseInputModal).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    await act(async () => { report.resolve(reportReceipt()); await pending; });
  });

  it("反问恢复等待期间切换面试，旧读取和旧重试不影响新面试", async () => {
    const read = deferred<InterviewData>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockResolvedValueOnce(reverseReceipt("A 提问"))
      .mockRejectedValueOnce(new Error("读取失败")).mockReturnValueOnce(read.promise).mockResolvedValueOnce(interview(2));
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.handleStartReverse());
    await act(async () => { await result.current.handleSubmitReverse("A 提问"); });
    const old = result.current;
    let pending!: Promise<void>;
    act(() => { pending = result.current.retryReverseRead(); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    await act(async () => { read.resolve(savedReverse()); await pending; await old.retryReverseRead(); });
    expect(result.current.data?.id).toBe(2);
    expect(result.current.reverseBusy).toBe(false);
    expect(result.current.reverseReadRecovery).toBeNull();
    expect(result.current.reverseError).toBe("");
    expect(result.current.showReverseInputModal).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(5);
  });
});

describe("面试提交后的读取恢复", () => {
  it.each(["saved", "unsaved", "read-failed"])("真实 SSE 包装收到 HTTP 200 HTML 后按未确认状态核对作答：%s", async outcome => {
    const realStream = await vi.importActual<typeof import("@/lib/fetch-sse")>("@/lib/fetch-sse");
    vi.mocked(fetchSse).mockImplementationOnce(realStream.fetchSse);
    const upstream = vi.fn().mockResolvedValue(new Response("<html>应用正在重启</html>", {
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", upstream);
    vi.mocked(jsonFetch).mockReset().mockResolvedValueOnce(interview(1));
    if (outcome === "read-failed") vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("核对读取失败"));
    else vi.mocked(jsonFetch).mockResolvedValueOnce(outcome === "saved" ? savedAnswer("原答") : interview(1));
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.setAnswer("原答"));
    await act(async () => { await result.current.submitAnswer(); });
    expect(result.current.busy).toBe(false);
    expect(upstream).toHaveBeenCalledOnce();
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    if (outcome === "saved") {
      expect(result.current.answer).toBe("");
      expect(result.current.current?.id).toBe(101);
      expect(result.current.error).toBe("");
      expect(result.current.readRecovery).toBeNull();
    } else if (outcome === "unsaved") {
      expect(result.current.answer).toBe("原答");
      expect(result.current.error).toContain("有效 JSON");
      expect(result.current.current?.id).toBe(100);
      expect(result.current.readRecovery).toBeNull();
    } else {
      expect(result.current.answer).toBe("原答");
      expect(result.current.error).toContain("保存状态暂无法确认");
      expect(result.current.error).not.toContain("作答已保存");
      expect(result.current.readRecovery).toEqual({ kind: "answer", confirmed: false });
      await act(async () => { await result.current.submitAnswer(); });
      expect(upstream).toHaveBeenCalledOnce();
    }
  });

  it.each([false, true])("作答已保存后读取失败只重读，连续触发不重复提交（末题=%s）", async (finished) => {
    const answer = " 本人只负责联调。\n";
    const read = deferred<InterviewData>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1))
      .mockRejectedValueOnce(new Error("本次读取失败"))
      .mockReturnValueOnce(read.promise);
    vi.mocked(fetchSse).mockImplementation(async (_url, options) => { await options.onDone?.({}); });
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.setAnswer(answer));
    await act(async () => { await Promise.all([result.current.submitAnswer(), result.current.submitAnswer()]); });
    expect(fetchSse).toHaveBeenCalledTimes(1);
    expect(result.current.error).toContain("作答已保存，读取结果失败");
    expect(result.current.readRecovery).toEqual({ kind: "answer", confirmed: true });
    expect(result.current.answer).toBe(answer);
    expect(result.current.busy).toBe(false);
    await act(async () => { await result.current.submitAnswer(); await result.current.generateReportDirectly(); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    let retry!: Promise<void>;
    act(() => { retry = result.current.retryResultRead(); void result.current.retryResultRead(); });
    expect(result.current.busy).toBe(true);
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { read.resolve(savedAnswer(answer, finished)); await retry; });
    expect(result.current.readRecovery).toBeNull();
    expect(result.current.answer).toBe("");
    expect(result.current.error).toBe("");
    expect(result.current.showReverseChoiceModal).toBe(finished);
    expect(result.current.current?.id).toBe(finished ? undefined : 101);
    expect(fetchSse).toHaveBeenCalledTimes(1);
  });

  it.each(["saved", "unsaved", "read-failed"])("响应丢失先核对作答状态：%s", async (outcome) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1));
    if (outcome === "read-failed") vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("读取也失败"));
    else vi.mocked(jsonFetch).mockResolvedValueOnce(outcome === "saved" ? savedAnswer("原答") : interview(1));
    vi.mocked(fetchSse).mockRejectedValueOnce(new Error("流式响应中断"));
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.setAnswer("原答"));
    await act(async () => { await result.current.submitAnswer(); });
    if (outcome === "saved") {
      expect(result.current.answer).toBe("");
      expect(result.current.error).toBe("");
      expect(result.current.current?.id).toBe(101);
    } else if (outcome === "unsaved") {
      expect(result.current.readRecovery).toBeNull();
      expect(result.current.answer).toBe("原答");
      expect(result.current.error).toBe("流式响应中断");
      expect(result.current.current?.id).toBe(100);
    } else {
      expect(result.current.readRecovery).toEqual({ kind: "answer", confirmed: false });
      expect(result.current.error).toContain("保存状态暂无法确认");
      vi.mocked(jsonFetch).mockResolvedValueOnce(savedAnswer("原答", true));
      await act(async () => { await result.current.retryResultRead(); });
      expect(result.current.readRecovery).toBeNull();
      expect(result.current.answer).toBe("");
      expect(result.current.showReverseChoiceModal).toBe(true);
    }
    expect(fetchSse).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "unanswered"])("完成事件后的%s记录不能让旧题再次提交", async (invalid) => {
    const stale = interview(1);
    if (invalid === "missing") stale.turns = [];
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockResolvedValueOnce(stale).mockResolvedValueOnce(savedAnswer("原答"));
    vi.mocked(fetchSse).mockImplementation(async (_url, options) => { await options.onDone?.({}); });
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.setAnswer("原答"));
    await act(async () => { await result.current.submitAnswer(); await result.current.submitAnswer(); });
    expect(result.current.readRecovery?.confirmed).toBe(true);
    expect(result.current.answer).toBe("原答");
    expect(fetchSse).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.retryResultRead(); });
    expect(result.current.readRecovery).toBeNull();
    expect(result.current.current?.id).toBe(101);
  });

  it.each(["原答", "另一页面的作答"])("等待读取期间的新草稿保留，服务器作答为 %s", async (storedAnswer) => {
    const read = deferred<InterviewData>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockReturnValueOnce(read.promise);
    vi.mocked(fetchSse).mockImplementation(async (_url, options) => { await options.onDone?.({}); });
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.setAnswer("原答"));
    let command!: Promise<void>;
    act(() => { command = result.current.submitAnswer(); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    act(() => result.current.setAnswer("新草稿"));
    await act(async () => { read.resolve(savedAnswer(storedAnswer)); await command; });
    expect(result.current.answer).toBe("新草稿");
    if (storedAnswer === "原答") expect(result.current.error).toBe("");
    else expect(result.current.error).toContain("该题已保存其他作答");
    expect(result.current.current?.id).toBe(101);
  });

  it.each([false, true])("报告已保存或响应丢失后只重读，不重复生成（丢失=%s）", async (lost) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1));
    if (lost) vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("响应丢失"));
    else vi.mocked(jsonFetch).mockResolvedValueOnce(reportReceipt());
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce(savedReport());
    const { result } = renderHook(() => useInterviewCommands("1"));
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    await act(async () => { await result.current.generateReportDirectly(); });
    expect(result.current.readRecovery).toEqual({ kind: "report", confirmed: !lost });
    expect(result.current.error).toContain(lost ? "保存状态暂无法确认" : "报告已保存，读取结果失败");
    await act(async () => { await result.current.generateReportDirectly(); await result.current.retryResultRead(); });
    expect(result.current.readRecovery).toBeNull();
    expect(result.current.data?.report?.strengths).toBe("分工明确");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("A 的延迟恢复不覆盖 B，旧重试入口不能提交 B", async () => {
    const read = deferred<InterviewData>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(interview(1)).mockRejectedValueOnce(new Error("读取失败"))
      .mockReturnValueOnce(read.promise).mockResolvedValueOnce(interview(2));
    vi.mocked(fetchSse).mockImplementation(async (_url, options) => { await options.onDone?.({}); });
    const { result, rerender } = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(result.current.data?.id).toBe(1));
    act(() => result.current.setAnswer("A 回答"));
    await act(async () => { await result.current.submitAnswer(); });
    const old = result.current;
    let retry!: Promise<void>;
    act(() => { retry = result.current.retryResultRead(); });
    rerender({ id: "2" });
    await waitFor(() => expect(result.current.data?.id).toBe(2));
    act(() => result.current.setAnswer("B 回答"));
    await act(async () => { read.resolve(savedAnswer("A 回答", true)); await retry; await old.retryResultRead(); });
    expect(result.current.data?.id).toBe(2);
    expect(result.current.answer).toBe("B 回答");
    expect(result.current.readRecovery).toBeNull();
    expect(result.current.error).toBe("");
    expect(result.current.busy).toBe(false);
    expect(result.current.showReverseChoiceModal).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(4);
  });
});
