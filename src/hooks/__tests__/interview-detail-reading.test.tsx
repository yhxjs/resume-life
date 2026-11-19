// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInterviewCommands, type InterviewData } from "../use-interview-session";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
const turn = { id: 10, idx: 1, kind: "question", question: "原问题 <T> &amp;", answer: "", comment: "", scores: null, reference: "", retries: [], answered_at: "", notebook_id: null };
const data: InterviewData = { id: 1, resume_title: "原简历", jd: "完整 JD", rounds: 3, style: "technical", series_id: null, round_no: 0, series_status: null, series_rounds: [], status: "ongoing", report: null, evaluator_report: null, reverse_interview: null, created_at: "", finished_at: "", turns: [turn] };
const scores = { depth: 7, structure: 8, authenticity: 9, completeness: 7 };
const report = { ...scores, jd_match: 8, overall: 7.8, strengths: "已有依据", weaknesses: "待核实", suggestions: "补充记录" };
const draft = "  未提交原文 <T> &amp;\n保留实际分工  ";
beforeEach(() => {
  vi.mocked(jsonFetch).mockReset(); vi.mocked(fetchSse).mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(100), 10));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const bad: [string, unknown][] = [
  ["null", null], ["wrong id", { ...data, id: 2 }], ["missing turns", { ...data, turns: undefined }],
  ["bad turns", { ...data, turns: [null] }], ["bad question", { ...data, turns: [{ ...turn, question: {} }] }],
  ["duplicate turns", { ...data, turns: [turn, turn] }], ["bad score", { ...data, turns: [{ ...turn, scores: { ...scores, depth: "7" } }] }],
  ["bad history", { ...data, turns: [{ ...turn, retries: [{}] }] }], ["bad reference", { ...data, turns: [{ ...turn, reference: 5 }] }],
  ["bad status", { ...data, status: "unknown" }], ["bad series", { ...data, series_rounds: [null] }],
  ["bad report", { ...data, report: {} }], ["bad mining", { ...data, report: { ...report, mining_summary: { actions: {} } } }],
  ["bad evaluator", { ...data, evaluator_report: { hire_reasons: [{}] } }],
  ["bad reverse", { ...data, reverse_interview: { question: "反问", answer: "答复", evaluation: {}, created_at: "" } }],
];
it.each(bad)("初次读取 %s 显示可重试错误，不写入或困在加载态", async (_label, response) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(response).mockResolvedValueOnce(data);
  const { result } = renderHook(() => useInterviewCommands("1"));
  await waitFor(() => expect(result.current.loadError).toContain("面试状态不完整"));
  expect(result.current.data).toBeNull();
  await act(async () => { await result.current.submitAnswer(); await result.current.generateReportDirectly(); });
  expect(jsonFetch).toHaveBeenCalledOnce();
  act(() => { result.current.retryLoad(); result.current.retryLoad(); });
  await waitFor(() => expect(result.current.data).toEqual(data));
  expect(result.current.loadError).toBe("");
  expect(fetchSse).not.toHaveBeenCalled();
  expect(jsonFetch).toHaveBeenCalledTimes(2);
});

it.each(["answer", "report", "reverse"])("%s 保存后残缺回读保留原页／草稿，只能主动 GET 恢复", async command => {
  const saved = { ...data, status: "finished", turns: [{ ...turn, answer: draft.trim(), answered_at: "saved" }] };
  const complete = command === "report" ? { ...saved, report } : command === "reverse" ? { ...saved, reverse_interview: {
    question: "真实提问", answer: "答复待核实", created_at: "saved", evaluation: { score: 7, level: "良好", insight: "依据", feedback: "反馈", suggestions: "建议" },
  } } : saved;
  const broken = { ...complete, turns: [{ ...complete.turns[0], scores: { ...scores, depth: {} } }] };
  let reads = 0;
  vi.mocked(jsonFetch).mockImplementation(async (_url, options) => options?.method === "POST"
    ? command === "report" ? { interview_id: 1, report, evaluator_report: null, finished_at: "saved" } : { interview_id: 1, ok: true, reverse: complete.reverse_interview }
    : (++reads === 1 ? data : reads === 2 ? broken : complete));
  vi.mocked(fetchSse).mockImplementation(async (_url, options) => { await options.onDone?.({}); });
  const { result } = renderHook(() => useInterviewCommands("1"));
  await waitFor(() => expect(result.current.data).toEqual(data));
  act(() => result.current.setAnswer(draft));
  const submit = () => command === "answer" ? result.current.submitAnswer() : command === "report" ? result.current.generateReportDirectly() : result.current.handleSubmitReverse("真实提问");
  await act(async () => { await submit(); });
  expect(result.current.data).toEqual(data);
  expect(result.current.answer).toBe(draft);
  expect(command === "reverse" ? result.current.reverseReadRecovery : result.current.readRecovery).not.toBeNull();
  const calls = vi.mocked(jsonFetch).mock.calls.length;
  await act(async () => { await submit(); });
  expect(jsonFetch).toHaveBeenCalledTimes(calls);
  await act(async () => { await (command === "reverse" ? result.current.retryReverseRead() : result.current.retryResultRead()); });
  expect(result.current.data).toEqual(complete);
  expect(command === "reverse" ? result.current.reverseReadRecovery : result.current.readRecovery).toBeNull();
  expect(reads).toBe(3);
  expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(command === "answer" ? 0 : 1);
  expect(fetchSse).toHaveBeenCalledTimes(command === "answer" ? 1 : 0);
});

it.each(["卸载", "切换"])("%s 中止待处理 GET，忽略取消的迟到回复不能污染新状态", async action => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...data, id: 2 });
  const page = renderHook(({ id }) => useInterviewCommands(id), { initialProps: { id: "1" } });
  await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  if (action === "卸载") page.unmount();
  else page.rerender({ id: "2" });
  await act(async () => { pending.resolve({ ...data, resume_title: "迟到旧数据" }); await pending.promise; });
  expect(signal?.aborted).toBe(true);
  if (action === "切换") expect(page.result.current.data?.id).toBe(2);
});

it("合法历史保留完整长文、小数分、空日期和错误提示，不套新生成篇幅上限", async () => {
  const text = ` \n<T> &amp; ${"完整原文".repeat(4000)}\n `;
  const saved = { ...data, jd: text, turns: [{ ...turn, answer: text, answered_at: "saved", scores: { ...scores, depth: 7.5 }, reference: text, retries_error: "重答历史暂无法读取，原始记录已保留" }] };
  vi.mocked(jsonFetch).mockResolvedValue(saved);
  const { result } = renderHook(() => useInterviewCommands("1"));
  await waitFor(() => expect(result.current.data).toEqual(saved));
  expect(result.current.data?.turns[0]?.answer).toBe(text);
  expect(result.current.loadError).toBe("");
});
