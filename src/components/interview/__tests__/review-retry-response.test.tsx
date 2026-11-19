// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InterviewReviewTurn, type ReviewTurnData, type TurnRetry } from "../review-turn";
import { jsonFetch } from "@/lib/fetcher";
import { createRequestId } from "@/lib/client-request-id";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/client-request-id", () => ({ createRequestId: vi.fn() }));
vi.mock("@/components/notebook", () => ({ NotebookStarButton: () => null }));
const requestId = "10000000-0000-4000-8000-000000000001";
const draft = "  实际重答 <T> &amp;\n未上线，结果待核实  ";
const own: TurnRetry = { id: `retry_${requestId}`, answer: draft.trim(), scores: { depth: 7, structure: 8, authenticity: 9, completeness: 7 }, comment: "本次点评", reference: "本次参考", created_at: "2026-11-03" };
const historical: TurnRetry = { ...own, id: "legacy", answer: "历史回答", scores: null, comment: "", reference: undefined };
const turn: ReviewTurnData = { id: 10, idx: 1, kind: "question", question: "如何验证？", answer: "原答", scores: null, comment: "原点评", reference: "原参考", retries: [historical], answered_at: "2026-11-03", notebook_id: null };
const updated = vi.fn();
function view(interviewId = 1, data = turn) {
  return <InterviewReviewTurn interviewId={interviewId} turn={data} onTurnUpdated={updated} onNotebookChanged={vi.fn()} />;
}
function submit() {
  fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: draft } });
  fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
}
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); vi.mocked(createRequestId).mockReset().mockReturnValue(requestId); updated.mockReset(); });
afterEach(cleanup);

const badPayloads: [string, unknown][] = [
  ["null", null], ["array", []], ["missing receipt", { retries: [historical, own] }],
  ["wrong request", { retry: { ...own, id: "other" }, retries: [historical, { ...own, id: "other" }] }],
  ["wrong answer", { retry: { ...own, answer: "其他回答" }, retries: [historical, { ...own, answer: "其他回答" }] }],
  ["missing history entry", { retry: own, retries: [historical] }],
  ["duplicate id", { retry: own, retries: [historical, own, own] }],
  ["receipt mismatch", { retry: own, retries: [historical, { ...own, reference: "不一致的参考" }] }],
  ...[null, {}, { ...historical, answer: {} }, { ...historical, comment: 42 }, { ...historical, reference: {} }, { ...historical, created_at: null }, { ...historical, scores: {} }, { ...historical, scores: { ...own.scores, depth: "7" } }, { ...historical, scores: { ...own.scores, depth: 11 } }].map((item, index): [string, unknown] => [`bad history ${index}`, { retry: own, retries: [item, own] }]),
];
it.each(badPayloads)("%s 不清稿、不更新历史；主动重试复用提交编号", async (_name, payload) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(payload).mockResolvedValueOnce({ retry: own, retries: [historical, own] });
  render(view());
  submit();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("请使用原提交重试"));
  expect(updated).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(draft);
  expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(turn.reference);
  expect(screen.queryByRole("button", { name: /重答#2/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
  await waitFor(() => expect(updated).toHaveBeenCalledExactlyOnceWith({ retries: [historical, own] }));
  const keys = vi.mocked(jsonFetch).mock.calls.map(([, options]) => new Headers(options?.headers).get("Idempotency-Key"));
  expect(keys).toEqual([requestId, requestId]);
  expect(createRequestId).toHaveBeenCalledOnce();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("恢复自己的历史版本而非最后一条，保留历史小数、空点评及长文本", async () => {
  const long = ` \n<T> &amp; ${"历史原文".repeat(4000)}\n `;
  const legacy = { ...historical, answer: long, reference: long, scores: { depth: 7.5, structure: 8, authenticity: 9, completeness: 7 } };
  const later = { ...own, id: "later", answer: "稍后其他提交" };
  const retries = [legacy, own, later];
  vi.mocked(jsonFetch).mockResolvedValue({ retry: own, retries });
  const page = render(view());
  submit();
  await waitFor(() => expect(updated).toHaveBeenCalledExactlyOnceWith({ retries }));
  page.rerender(view(1, { ...turn, retries }));
  expect(screen.getByRole("button", { name: /重答#2/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(own.reference);
  fireEvent.click(screen.getByRole("button", { name: /重答#1/ }));
  expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(long);
});

it.each(["成功", "失败"])("离页中止重答等待，迟到%s不调用旧宿主", async outcome => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const page = render(view());
  submit();
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  page.unmount();
  await act(async () => {
    if (outcome === "成功") pending.resolve({ retry: own, retries: [historical, own] });
    else pending.reject(new Error("迟到错误"));
    await pending.promise.catch(() => {});
  });
  expect(signal?.aborted).toBe(true);
  expect(updated).not.toHaveBeenCalled();
});
