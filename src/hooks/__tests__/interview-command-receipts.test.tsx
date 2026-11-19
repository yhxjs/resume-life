// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInterviewCommands, type InterviewData } from "../use-interview-session";
import { jsonFetch } from "@/lib/fetcher";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
const question = "如何核实 <T> &amp;\n实际验收范围？";
const scores = { depth: 7.5, structure: 8, authenticity: 7, completeness: 7 };
const report = { ...scores, jd_match: 8, overall: 7.5, strengths: "已有依据", weaknesses: "待验证", suggestions: "核实" };
const reverse = { question, answer: "模拟答复 <T> &amp;", created_at: "saved", evaluation: { score: 8, level: "优秀", insight: "具体", feedback: "依据", suggestions: "核实" } };
const initial: InterviewData = { id: 1, resume_title: "原简历", jd: "完整岗位", rounds: 1, style: "technical", status: "finished", series_id: null, round_no: 0, series_status: null, series_rounds: [],
  report: null, evaluator_report: null, reverse_interview: null, created_at: "", finished_at: "saved", turns: [] };
const reportReceipt = { interview_id: 1, report, evaluator_report: null, finished_at: "saved" };
const reverseReceipt = { interview_id: 1, ok: true, reverse };
const miningSummary = { project_name: "项目", background: "", actions: "实际行动", tradeoffs: "", results: "待核实", contribution: "", resume_bullets: [], pending_confirmations: [] };
type Kind = "report" | "reverse";
const invalid: [Kind, string, unknown, string?][] = [
  ["report", "仅 ok", { ok: true }], ["report", "布尔", true], ["report", "数组", []],
  ["report", "缺归属", { ...reportReceipt, interview_id: undefined }], ["report", "错归属", { ...reportReceipt, interview_id: 2 }],
  ["report", "缺报告", { ...reportReceipt, report: null }], ["report", "坏报告", { ...reportReceipt, report: { ...report, strengths: {} } }],
  ["report", "错分数", { ...reportReceipt, report: { ...report, overall: "7" } }],
  ["report", "缺时间", { ...reportReceipt, finished_at: undefined }], ["report", "空时间", { ...reportReceipt, finished_at: " " }],
  ["report", "缺评估字段", { ...reportReceipt, evaluator_report: undefined }], ["report", "坏评估", { ...reportReceipt, evaluator_report: {} }],
  ["report", "缺挖掘成果", reportReceipt, "mining"], ["report", "坏挖掘成果", { ...reportReceipt, report: { ...report, mining_summary: {} } }, "mining"],
  ["reverse", "仅 ok", { ok: true }], ["reverse", "错确认", { ...reverseReceipt, ok: "true" }],
  ["reverse", "缺归属", { ...reverseReceipt, interview_id: undefined }], ["reverse", "错归属", { ...reverseReceipt, interview_id: 2 }],
  ["reverse", "缺反问", { ...reverseReceipt, reverse: null }], ["reverse", "错问题", { ...reverseReceipt, reverse: { ...reverse, question: "另一问题" } }],
  ["reverse", "坏答复", { ...reverseReceipt, reverse: { ...reverse, answer: {} } }], ["reverse", "空答复", { ...reverseReceipt, reverse: { ...reverse, answer: " " } }],
  ["reverse", "坏评价", { ...reverseReceipt, reverse: { ...reverse, evaluation: { ...reverse.evaluation, score: 11 } } }],
  ["reverse", "缺时间", { ...reverseReceipt, reverse: { ...reverse, created_at: undefined } }], ["reverse", "空时间", { ...reverseReceipt, reverse: { ...reverse, created_at: "" } }],
];
beforeEach(() => {
  vi.mocked(jsonFetch).mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(100), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const countPosts = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST").length;
const saved = (kind: Kind, base = initial) => kind === "report" ? { ...base, report: { ...report, ...(base.style === "mining" ? { mining_summary: miningSummary } : {}) } } : { ...base, reverse_interview: reverse };

it.each(invalid)("%s 的%s成功回包不假报保存，回读失败保留草稿且只 GET 恢复", async (kind, _label, receipt, style) => {
  const data = { ...initial, style: style ?? initial.style };
  vi.mocked(jsonFetch).mockResolvedValueOnce(data).mockResolvedValueOnce(receipt).mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce(saved(kind, data));
  const { result } = renderHook(() => useInterviewCommands("1"));
  await waitFor(() => expect(result.current.data).toEqual(data));
  act(() => { result.current.setAnswer("  原作答草稿  "); result.current.handleStartReverse(); });
  const submit = () => kind === "report" ? result.current.generateReportDirectly() : result.current.handleSubmitReverse(`  ${question}  `);
  await act(async () => { await submit(); });
  expect((kind === "report" ? result.current.readRecovery : result.current.reverseReadRecovery)?.confirmed).toBe(false);
  expect(kind === "report" ? result.current.error : result.current.reverseError).toContain("保存状态暂无法确认");
  expect(result.current.data).toEqual(data); expect(result.current.answer).toBe("  原作答草稿  ");
  await act(async () => { await submit(); }); expect(countPosts()).toBe(1);
  await act(async () => { await (kind === "report" ? result.current.retryResultRead() : result.current.retryReverseRead()); });
  expect(kind === "report" ? result.current.readRecovery : result.current.reverseReadRecovery).toBeNull();
  expect(result.current.data).toEqual(saved(kind, data)); expect(countPosts()).toBe(1);
});

it.each(["report", "reverse"] as const)("%s 合法回执保留确认语义，空快照不解除只读保护", async kind => {
  const receipt = kind === "report" ? reportReceipt : reverseReceipt;
  vi.mocked(jsonFetch).mockResolvedValueOnce(initial).mockResolvedValueOnce(receipt).mockResolvedValueOnce(initial).mockResolvedValueOnce(saved(kind));
  const { result } = renderHook(() => useInterviewCommands("1"));
  await waitFor(() => expect(result.current.data).toEqual(initial));
  await act(async () => { await (kind === "report" ? result.current.generateReportDirectly() : result.current.handleSubmitReverse(question)); });
  expect((kind === "report" ? result.current.readRecovery : result.current.reverseReadRecovery)?.confirmed).toBe(true);
  expect(result.current.data).toEqual(initial);
  await act(async () => { await (kind === "report" ? result.current.retryResultRead() : result.current.retryReverseRead()); });
  expect(result.current.data).toEqual(saved(kind)); expect(countPosts()).toBe(1);
});

it.each(["report", "reverse"] as const)("%s 坏回执后读到尚无结果不永久假报已保存，只允许再次主动提交", async kind => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(initial).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(kind === "report" ? reportReceipt : reverseReceipt).mockResolvedValueOnce(saved(kind));
  const { result } = renderHook(() => useInterviewCommands("1"));
  await waitFor(() => expect(result.current.data).toEqual(initial));
  const submit = () => kind === "report" ? result.current.generateReportDirectly() : result.current.handleSubmitReverse(question);
  await act(async () => { await submit(); });
  expect(kind === "report" ? result.current.readRecovery : result.current.reverseReadRecovery).toBeNull();
  expect(kind === "report" ? result.current.error : result.current.reverseError).toContain("保存回执不完整");
  expect(countPosts()).toBe(1);
  await act(async () => { await submit(); });
  expect(result.current.data).toEqual(saved(kind)); expect(countPosts()).toBe(2);
});
