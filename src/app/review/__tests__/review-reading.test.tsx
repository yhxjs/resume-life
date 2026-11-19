// @vitest-environment jsdom
import { Component, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { jsonFetch } from "@/lib/fetcher";
import { reviewDashboardFixture, emptyReviewDashboardFixture } from "../../../../tests/support/review-dashboard";
import ReviewPage from "../page";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
class CatchRenderError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p>页面渲染已崩溃</p> : this.props.children; }
}
function show() { return render(<CatchRenderError><ReviewPage /></CatchRenderError>); }
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

it.each([
  ["缺少统计字段", {}],
  ["数字字符串", { ...reviewDashboardFixture(), overallScore: "6.4" }],
  ["伪空记录", { ...reviewDashboardFixture(), totals: { drills: 0, interviews: 0, scoredAnswers: 0 } }],
  ["缺少一维评分", { ...reviewDashboardFixture(), overall: { depth: 7 } }],
  ["有作答却无综合分", { ...reviewDashboardFixture(), overallScore: null }],
])("%s 返回页内读取错误，不崩溃、不伪造零分或空记录", async (_name, body) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(jsonFetch).mockResolvedValue(body);
  show();
  await waitFor(() => expect(screen.queryByRole("alert")?.textContent).toContain("复盘数据不完整或不一致"));
  expect(screen.queryByText("页面渲染已崩溃")).toBeNull();
  expect(screen.queryByText("本次统计综合均分")).toBeNull();
  expect(screen.queryByText(/还没有已评分的作答记录/)).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "重试加载" })).toBeDefined();
});

it("坏回复后手动只读重试，等待期间隐藏错误，成功完整显示且不缓存", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...reviewDashboardFixture(), overallScore: null });
  show();
  await screen.findByRole("alert");
  let finish!: (value: unknown) => void;
  vi.mocked(jsonFetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await screen.findByRole("status");
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => finish(reviewDashboardFixture()));
  expect(screen.getByText("本次统计综合均分").parentElement?.textContent).toContain("6.4");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  for (const [url, init] of vi.mocked(jsonFetch).mock.calls) {
    expect(url).toBe("/api/review");
    expect(init).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
  }
});

it("合法空统计才显示引导，零分不会被当作缺少数据", async () => {
  vi.mocked(jsonFetch).mockResolvedValue(emptyReviewDashboardFixture());
  const view = show();
  await screen.findByText(/还没有已评分的作答记录/);
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
  const data = reviewDashboardFixture();
  data.overall = data.drillAvg = data.interviewAvg = { depth: 0, structure: 0, authenticity: 0, completeness: 0 };
  data.overallScore = 0;
  data.sessions.forEach(session => { session.avg = data.overall; session.overall = 0; });
  data.projects[0]!.overall = 0;
  vi.mocked(jsonFetch).mockResolvedValue(data);
  show();
  await screen.findByText("本次统计综合均分");
  expect(screen.getByText("本次统计综合均分").parentElement?.textContent).toContain("0.0");
  expect(screen.queryByText(/还没有已评分的作答记录/)).toBeNull();
});

it.each(["success", "failure"])("离页取消等待，旧请求迟到 %s 不能污染新挂载页面", async mode => {
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  vi.mocked(jsonFetch).mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const old = show();
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  old.unmount();
  expect(signal?.aborted).toBe(true);
  vi.mocked(jsonFetch).mockResolvedValueOnce(emptyReviewDashboardFixture());
  show();
  await screen.findByText(/还没有已评分的作答记录/);
  await act(async () => { if (mode === "success") finish(reviewDashboardFixture()); else fail(new Error("旧请求迟到错误")); });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("本次统计综合均分")).toBeNull();
  expect(screen.getByText(/还没有已评分的作答记录/)).toBeDefined();
});
