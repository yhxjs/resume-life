// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InterviewReviewTurn, type ReviewTurnData } from "../review-turn";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/notebook", () => ({ NotebookStarButton: () => null }));
const turn: ReviewTurnData = {
  id: 10, idx: 1, kind: "question", question: "如何验证接口兼容性？", answer: "仅参与参数校验，尚未上线。",
  comment: "保留实际分工", scores: null, reference: "已保存参考 <T> &amp;\n内部  空格，结果待核实。",
  retries: [], answered_at: "历史时间", notebook_id: null,
};
const updated = vi.fn();
function view(interviewId = 1, data = turn) {
  return <InterviewReviewTurn interviewId={interviewId} turn={data} onTurnUpdated={updated} onNotebookChanged={vi.fn()} />;
}
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); updated.mockReset(); });
afterEach(cleanup);

it.each([null, [], {}, { reference: null }, { reference: true }, { reference: 123 }, { reference: {} }, { reference: ["伪正文"] }, { reference: "" }, { reference: " \n\t " }])(
  "参考回包 %j 拒绝更新，保留原参考和重答草稿，明确提示后允许主动再生成", async response => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    render(view());
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  我的未提交草稿 <T>\n仍待核实  " } });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("参考答案响应不完整"));
    expect(updated).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(turn.reference);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("  我的未提交草稿 <T>\n仍待核实  ");
    expect(jsonFetch).toHaveBeenCalledOnce();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ reference: "重新生成的合法参考" });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(updated).toHaveBeenCalledExactlyOnceWith({ reference: "重新生成的合法参考" }));
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  },
);

it("合法参考保留前后空白、技术字面量和长正文，不套生成上限截断", async () => {
  const reference = ` \n<T> &amp; ${"原文".repeat(6000)}\n  `;
  vi.mocked(jsonFetch).mockResolvedValue({ reference });
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await waitFor(() => expect(updated).toHaveBeenCalledExactlyOnceWith({ reference }));
});

it.each(["成功", "失败"])("离页中止参考等待，忽略取消的迟到%s不更新旧宿主", async outcome => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const page = render(view());
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  page.unmount();
  await act(async () => {
    if (outcome === "成功") pending.resolve({ reference: "旧页迟到参考" });
    else pending.reject(new Error("旧页迟到错误"));
    await pending.promise.catch(() => {});
  });
  expect(signal?.aborted).toBe(true);
  expect(updated).not.toHaveBeenCalled();
});

it("切换题目中止旧参考，新请求保持独立锁，旧回复不提前解锁", async () => {
  const old = Promise.withResolvers<unknown>();
  const current = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const page = render(view());
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  page.rerender(view(2, { ...turn, id: 20, reference: "新题原参考" }));
  const button = screen.getByRole("button", { name: "重新生成" });
  act(() => { button.click(); button.click(); });
  await act(async () => { old.resolve({ reference: "旧题迟到参考" }); await old.promise; });
  expect(signal?.aborted).toBe(true);
  expect(updated).not.toHaveBeenCalled();
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect((screen.getByRole("button", { name: "生成中…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe("新题原参考");
  await act(async () => { current.resolve({ reference: "新题新参考" }); await current.promise; });
  expect(updated).toHaveBeenCalledExactlyOnceWith({ reference: "新题新参考" });
});
