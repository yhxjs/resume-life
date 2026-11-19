// @vitest-environment jsdom
import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { InterviewAnswerPanel } from "@/components/interview/interview-answer-panel";
import { useInterviewCommands, type InterviewData } from "../use-interview-session";
import { jsonFetch } from "@/lib/fetcher";
import { fetchSse } from "@/lib/fetch-sse";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
const draft = "  未提交草稿 <T> &amp;\n尚未上线  ";
const title = "完整简历标题 <T> &amp; " + "技术经历_".repeat(25);
const turn = { id: 10, idx: 1, kind: "question", question: "原题", answer: "已保存原答", comment: "原点评", scores: null, reference: "", retries: [], answered_at: "saved", notebook_id: null };
function detail(id = 1): InterviewData {
  return { id, resume_title: title, resume_version_id: 31, resume_version: 3, resume_version_name: "原发布版", jd: "完整岗位", rounds: 4, style: "technical", series_id: null, round_no: 0,
    series_status: null, series_rounds: [], status: "ongoing", report: null, evaluator_report: null, reverse_interview: null, created_at: "2026-11-03 12:00:00", finished_at: "",
    turns: [turn, { ...turn, id: 11, idx: 2, question: "当前题", answer: "", comment: "", answered_at: "" }] };
}
const saved: InterviewData = { ...detail(), status: "finished", report: { depth: 7, structure: 8, authenticity: 8, completeness: 7, jd_match: 7, overall: 7.5, strengths: "已有依据", weaknesses: "待验证", suggestions: "核实" } };
let commands: ReturnType<typeof useInterviewCommands>;
function Owner({ id }: { id: string }) {
  const current = useInterviewCommands(id);
  useLayoutEffect(() => { commands = current; });
  if (!current.data) return null;
  return <InterviewAnswerPanel data={current.data} current={current.current} answer={current.answer} setAnswer={current.setAnswer}
    busy={current.busy} confirmingFinish={current.confirmingFinish} error={current.error} readRecovery={current.readRecovery} onRetryRead={current.retryResultRead}
    answeredCount={current.answeredCount} displayedText={current.answerTypewriter.displayedText} isTyping={current.answerTypewriter.isTyping}
    onFinish={current.finish} onSubmitAnswer={current.submitAnswer} onGenerateReport={current.generateReportDirectly} onOpenReverse={current.handleStartReverse} />;
}
function Scene({ shown = true, id = "1" }: { shown?: boolean; id?: string }) { return <><ConfirmDialogHost />{shown && <Owner id={id} />}</>; }
beforeEach(() => {
  vi.mocked(jsonFetch).mockReset(); vi.mocked(fetchSse).mockReset();
  vi.mocked(jsonFetch).mockImplementation(async (url, options) => options?.method === "POST" ? { interview_id: 1, report: saved.report, evaluator_report: null, finished_at: "saved" } : detail(url.endsWith("/2") ? 2 : 1));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(100), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST");
async function setup() {
  const view = render(<Scene />);
  await waitFor(() => expect(commands.data?.id).toBe(1));
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: draft } });
  const trigger = screen.getByRole("button", { name: "提前结束并生成总结" }) as HTMLButtonElement;
  trigger.focus();
  return { view, input, trigger, old: commands };
}

it.each(["卸载", "切换"])("%s 立即移除所属确认，旧入口不能再次排队或提交", async mode => {
  const { view, trigger, old } = await setup();
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog").textContent).toContain("提前结束");
  view.rerender(mode === "卸载" ? <Scene shown={false} /> : <Scene id="2" />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await act(async () => { await old.finish(); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(posts()).toHaveLength(0);
  if (mode === "切换") expect(commands.data?.id).toBe(2);
});

it.each(["卸载", "切换"])("%s 只移除所属排队确认，保留其他确认的顺序", async mode => {
  const { view, old } = await setup();
  act(() => { void confirmDialog({ title: "其他当前确认", message: "继续保留" }); void old.finish(); void confirmDialog({ title: "其他后续确认", message: "也需保留" }); });
  view.rerender(mode === "卸载" ? <Scene shown={false} /> : <Scene id="2" />);
  if (mode === "切换") await waitFor(() => expect(commands.data?.id).toBe(2));
  expect(screen.getByRole("dialog").textContent).toContain("其他当前确认");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("dialog").textContent).toContain("其他后续确认");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(posts()).toHaveLength(0);
});

it.each(["取消", "Escape"])("同事件重复结束只确认一次，%s 保留草稿并返回焦点", async action => {
  const { trigger, input } = await setup();
  act(() => { trigger.click(); trigger.click(); });
  expect(trigger.disabled).toBe(false);
  if (action === "取消") fireEvent.click(screen.getByRole("button", { name: "取消" }));
  else fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(input.value).toBe(draft);
  expect(input.disabled).toBe(false);
  expect(posts()).toHaveLength(0);
});

it("确认期间锁住编辑和其他命令，不显示正在生成，也不排第二项确认", async () => {
  const { trigger, input, old } = await setup();
  fireEvent.click(trigger);
  expect(input.disabled).toBe(true);
  expect((screen.getByRole("button", { name: "提交回答" }) as HTMLButtonElement).disabled).toBe(true);
  expect(commands.busy).toBe(false);
  expect(screen.queryByText("考官正在评估作答…")).toBeNull();
  await act(async () => {
    void old.finish(); await old.submitAnswer(); await old.generateReportDirectly();
    old.handleStartReverse(); await old.handleSubmitReverse("反问"); await old.handleSkipReverse();
  });
  expect(posts()).toHaveLength(0);
  expect(fetchSse).not.toHaveBeenCalled();
  expect(commands.showReverseInputModal).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(input.value).toBe(draft);
});

it("确认展示完整所属面试、简历、创建时间及未提交草稿影响", async () => {
  const { trigger } = await setup();
  fireEvent.click(trigger);
  const content = screen.getByRole("dialog").textContent;
  for (const text of ["面试 #1", title, "2026-11-03 12:00:00", "已保存 1 题", "未提交草稿", "不会提交或计分"]) expect(content).toContain(text);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消" })); });
});

it.each(["卸载", "切换"])("接受后同事件%s 不启动旧报告请求", async mode => {
  const { view, trigger } = await setup();
  fireEvent.click(trigger);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "结束并生成报告" }));
    view.rerender(mode === "卸载" ? <Scene shown={false} /> : <Scene id="2" />);
  });
  expect(posts()).toHaveLength(0);
});

it("取消后重新确认只生成一次报告，不把未提交草稿写成回答", async () => {
  const { trigger, input } = await setup();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(input.value).toBe(draft);
  vi.mocked(jsonFetch).mockImplementation(async (_url, options) => options?.method === "POST" ? { interview_id: 1, report: saved.report, evaluator_report: null, finished_at: "saved" } : saved);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "结束并生成报告" }));
  await waitFor(() => expect(commands.data?.report).toEqual(saved.report));
  expect(posts()).toEqual([["/api/interviews/1/finish", { method: "POST" }]]);
  expect(fetchSse).not.toHaveBeenCalled();
  expect(commands.answer).toBe(draft);
  expect(commands.busy).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("旧确认清理不释放新面试的确认锁", async () => {
  const { view, trigger, old } = await setup();
  fireEvent.click(trigger);
  view.rerender(<Scene id="2" />);
  await waitFor(() => expect(commands.data?.id).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "提前结束并生成总结" }));
  await act(async () => { void old.finish(); await old.generateReportDirectly(); });
  expect(screen.getByRole("dialog").textContent).toContain("面试 #2");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(posts()).toHaveLength(0);
});
