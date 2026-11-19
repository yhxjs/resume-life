// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InterviewReviewTurn, type ReviewTurnData } from "../review-turn";
import { jsonFetch } from "@/lib/fetcher";
import { ORIGINAL_SCORES_UNAVAILABLE } from "@/lib/interview-original-scores";
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/notebook", () => ({ NotebookStarButton: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const turn: ReviewTurnData = { id: 1, idx: 1, kind: "question", question: "原题", answer: "原答", comment: "原点评", scores: null, reference: "原参考", retries: [], answered_at: "已答", notebook_id: null };
const warning = "重答历史暂无法读取，原始记录已保留";
const updated = vi.fn();
const view = (data = turn) => <InterviewReviewTurn interviewId={1} turn={data} onTurnUpdated={updated} onNotebookChanged={vi.fn()} />;

it("原答评分异常不隐藏原答和参考，独立重答仍可查看且不冒充原分已修复", () => {
  const retry = { id: "legacy", answer: "重答原文", scores: { depth: 7.5, structure: 8, authenticity: 7, completeness: 9 }, comment: "历史点评", created_at: "" };
  render(view({ ...turn, scores_error: ORIGINAL_SCORES_UNAVAILABLE, retries: [retry] }));
  expect(screen.getByText("重答原文")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "原答" }));
  expect(screen.getByRole("alert").textContent).toBe(ORIGINAL_SCORES_UNAVAILABLE);
  expect(screen.getByText("原答", { selector: "div" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe("原参考");
  expect((screen.getByRole("button", { name: /重答这一题/ }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /重答#1/ }));
  expect(screen.getByText("7.5")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(jsonFetch).not.toHaveBeenCalled();
});

it("历史损坏仍展示原题原答参考，明确提示且不可新增重答", () => {
  render(view({ ...turn, retries_error: warning }));
  expect(screen.getByRole("alert").textContent).toBe(warning);
  expect(screen.getByText("原答")).toBeTruthy();
  expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe("原参考");
  const button = screen.getByRole("button", { name: /重答这一题/ }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/重答暂时停用/)).toBeTruthy();
  expect(screen.queryByText(/随时可以发起重答/)).toBeNull();
  fireEvent.click(button);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(jsonFetch).not.toHaveBeenCalled();
});

it("缺少历史正文不冒充尚未作答，仍可查看题目参考", () => {
  render(view({ ...turn, retries: [{ id: "legacy", answer: "", scores: null, comment: "", created_at: "" }] }));
  expect(screen.getByText("（该次重答未保存回答正文）")).toBeTruthy();
  expect(screen.queryByText("（未作答）")).toBeNull();
  expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe("原参考");
  expect(jsonFetch).not.toHaveBeenCalled();
});

it("已有草稿收到历史损坏状态时仍保留草稿，不能继续提交；恢复后入口可用", () => {
  const page = render(view());
  fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  本地未提交原稿\n<T>  " } });
  page.rerender(view({ ...turn, retries_error: warning }));
  const submit = screen.getByRole("button", { name: "提交并重新评分" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(submit);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("  本地未提交原稿\n<T>  ");
  expect(jsonFetch).not.toHaveBeenCalled();
  expect(updated).not.toHaveBeenCalled();
  page.rerender(view());
  expect(submit.disabled).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});
