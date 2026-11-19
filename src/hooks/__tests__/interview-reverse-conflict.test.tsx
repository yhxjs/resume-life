// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { useInterviewCommands, type InterviewData } from "../use-interview-session";
import { ReverseInterviewModals } from "@/components/interview/reverse-modals";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

const initial: InterviewData = { id: 1, resume_title: "反问原简历", jd: "岗位原文", rounds: 1, style: "technical", status: "finished",
  series_id: null, round_no: 0, series_status: null, series_rounds: [], turns: [], report: null, evaluator_report: null, reverse_interview: null, created_at: "", finished_at: "saved" };
const draft = "  如何核实接口 <T> &amp;\n尚未验证的验收范围？  ";
const reverse = { question: "另一处已保存的问题", answer: "另一份模拟回答", evaluation: { score: 7.5, level: "优秀", insight: "信息依据", feedback: "具体", suggestions: "核实" }, created_at: "saved" };
const report = { depth: 7, structure: 8, authenticity: 8, completeness: 7, jd_match: 8, overall: 7.5, strengths: "分工", weaknesses: "待验证", suggestions: "核对" };
let commands: ReturnType<typeof useInterviewCommands>;
function Harness({ id = "1" }: { id?: string }) {
  const session = useInterviewCommands(id);
  useLayoutEffect(() => { commands = session; });
  return <>
    <button onClick={session.handleStartReverse}>打开反问</button>
    <output>{session.data?.resume_title}</output>
    <ReverseInterviewModals showChoiceModal={session.showReverseChoiceModal} showInputModal={session.showReverseInputModal}
      interviewerLabel="技术面试官" busy={session.busy} reverseBusy={session.reverseBusy} reverseError={session.reverseError}
      reverseReadRecovery={session.reverseReadRecovery} reverseConflict={session.reverseConflict}
      onRetryReverseRead={session.retryReverseRead} onSkipChoice={session.handleSkipReverse} onStartChoice={session.handleStartReverse}
      onCloseInput={() => session.setShowReverseInputModal(false)} onGiveUpInput={session.handleSkipReverse} onSubmitReverse={session.handleSubmitReverse} />
  </>;
}
beforeEach(() => {
  vi.mocked(jsonFetch).mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(100), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function open() {
  await waitFor(() => expect(commands.data?.id).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "打开反问" }));
  const dialog = screen.getByRole("dialog");
  const input = within(dialog).getByRole("textbox", { name: "我的反问问题" }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: draft } });
  return { dialog, input, old: commands };
}
const postCount = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST").length;

for (const acknowledged of [false, true]) {
  for (const delayed of [false, true]) {
    it.each(["question", "report"] as const)(`%s 冲突保留逐字草稿和核对出口，禁止旧入口写入（确认=${acknowledged}，重读=${delayed}）`, async kind => {
      const saved = { ...initial, reverse_interview: kind === "question" ? reverse : null, report: kind === "report" ? report : null };
      let reads = 0;
      vi.mocked(jsonFetch).mockImplementation(async (_url, options) => {
        if (options?.method === "POST") {
          if (!acknowledged) throw new Error("保存响应丢失");
          return { interview_id: 1, ok: true, reverse: { ...reverse, question: draft.trim() } };
        }
        reads++;
        if (reads === 1) return initial;
        if (delayed && reads === 2) throw new Error("暂时无法读取");
        return saved;
      });
      render(<Harness />);
      const { input, old } = await open();
      await act(async () => { await commands.handleSubmitReverse(draft); });
      if (delayed) {
        expect(input.value).toBe(draft);
        expect(commands.reverseReadRecovery).not.toBeNull();
        await act(async () => { await commands.retryReverseRead(); });
      }
      expect(screen.queryByRole("dialog")).not.toBeNull();
      expect(input.value).toBe(draft);
      expect(input.readOnly).toBe(true);
      expect(input.disabled).toBe(false);
      expect(screen.getByRole("alert").textContent).toContain(kind === "question" ? "不同的反问问题" : "未读取到本次反问");
      expect(screen.queryByRole("button", { name: "向面试官提问" })).toBeNull();
      expect(screen.queryByRole("button", { name: "放弃反问，直接生成报告" })).toBeNull();
      expect(commands.data).toEqual(saved);
      expect(commands.reverseReadRecovery).toBeNull();
      await act(async () => {
        await old.handleSubmitReverse("旧入口重复提交"); await commands.handleSubmitReverse(draft);
        await old.handleSkipReverse(); await commands.generateReportDirectly(); await commands.retryReverseRead();
      });
      expect(postCount()).toBe(1);
      expect(reads).toBe(delayed ? 3 : 2);
      fireEvent.click(screen.getByRole("button", { name: "查看已保存结果" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => { old.handleStartReverse(); await old.handleSubmitReverse(draft); });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(postCount()).toBe(1);
    });
  }
}

it.each([false, true])("同一提交仅去首尾空白，合法长文恢复正常关闭（响应丢失=%s）", async lost => {
  const question = `  ${draft.trim()}${"完整问题".repeat(4000)}  `;
  let reads = 0;
  vi.mocked(jsonFetch).mockImplementation(async (_url, options) => {
    if (options?.method === "POST") { if (lost) throw new Error("响应丢失"); return { interview_id: 1, ok: true, reverse: { ...reverse, question: question.trim() } }; }
    return ++reads === 1 ? initial : { ...initial, reverse_interview: { ...reverse, question: question.trim() } };
  });
  render(<Harness />);
  await open();
  await act(async () => { await commands.handleSubmitReverse(question); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(commands.reverseError).toBe("");
  expect(commands.data?.reverse_interview?.question).toBe(question.trim());
  expect(postCount()).toBe(1);
});

it("内部空白差异不冒充同一问题，冲突可 Escape 退出且不产生报告", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(initial).mockResolvedValueOnce({ interview_id: 1, ok: true, reverse: { ...reverse, question: draft.trim() } })
    .mockResolvedValueOnce({ ...initial, reverse_interview: { ...reverse, question: draft.trim().replace("\n", " ") } });
  render(<Harness />);
  await open();
  await act(async () => { await commands.handleSubmitReverse(draft); });
  expect(screen.queryByRole("dialog")).not.toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(postCount()).toBe(1);
});

it("切换面试清除旧冲突，不让旧命令更新新面试", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(initial).mockResolvedValueOnce({ interview_id: 1, ok: true, reverse: { ...reverse, question: draft.trim() } })
    .mockResolvedValueOnce({ ...initial, reverse_interview: reverse }).mockResolvedValueOnce({ ...initial, id: 2, resume_title: "新面试" });
  const view = render(<Harness />);
  const { old } = await open();
  await act(async () => { await commands.handleSubmitReverse(draft); });
  expect(screen.queryByRole("dialog")).not.toBeNull();
  view.rerender(<Harness id="2" />);
  await waitFor(() => expect(commands.data?.id).toBe(2));
  await act(async () => { await old.retryReverseRead(); await old.handleSubmitReverse(draft); old.setShowReverseInputModal(false); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(commands.reverseConflict).toBe(false);
  expect(commands.reverseError).toBe("");
  expect(postCount()).toBe(1);
});
