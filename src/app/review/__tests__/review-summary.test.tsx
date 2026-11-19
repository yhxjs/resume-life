// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { jsonFetch } from "@/lib/fetcher";
import { overallOf, type ScoreMap } from "@/lib/scores";
import ReviewPage from "../page";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/review/score-charts", () => ({
  DIM_COLORS: {}, TrendChart: () => null, RadarChart: () => null,
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function showReview(overall: ScoreMap, truncated = false) {
  const data = {
    totals: { drills: 3, interviews: 2, scoredAnswers: truncated ? 10_002 : 5 },
    overall, overallScore: overallOf(overall), drillAvg: overall, interviewAvg: overall,
    truncated, sessions: Array.from({ length: 5 }, (_, i) => ({
      id: `${i < 3 ? "drill" : "interview"}-${i + 1}`, kind: i < 3 ? "drill" : "interview",
      label: `场次 ${i + 1}`, date: "2026-11-03", count: truncated && i === 0 ? 9_998 : 1,
      avg: overall, overall: overallOf(overall),
    })), projects: [{ id: 1, name: "项目原名", answers: 2, overall: overallOf(overall) }],
  };
  vi.mocked(jsonFetch).mockResolvedValue(data);
  render(<ReviewPage />);
  await screen.findByText("薄弱维度定向分析");
  return screen.getByText("薄弱维度定向分析").closest("section")!;
}

it.each([0, 7.4, 10])("四维同为 %s 分时不根据排序制造强弱", async value => {
  const section = await showReview({ depth: value, structure: value, authenticity: value, completeness: value });
  expect(section.textContent).toContain(`四个维度的均分均为 ${value.toFixed(1)} 分`);
  expect(section.textContent).toContain("当前没有分数高低差异");
  expect(section.textContent).not.toMatch(/最具优势|最需补强|核心补强项|并列较低|相对较低/);
  for (const row of within(section).getAllByRole("listitem")) {
    expect(within(row).getByRole("meter").getAttribute("aria-valuenow")).toBe(String(value));
    expect(within(row).getByRole("meter").firstElementChild?.getAttribute("style")).toBe(`width: ${value * 10}%;`);
  }
});

it("最高与最低并列时完整列出相关维度，每个最低维度都有同等标记", async () => {
  const section = await showReview({ depth: 4.2, structure: 8.2, authenticity: 8.2, completeness: 4.2 });
  expect(section.textContent).toContain("结构表达、真实性");
  expect(section.textContent).toContain("技术深度、完整度");
  expect(within(section).getAllByText("并列较低", { exact: true })).toHaveLength(2);
  const lowRows = within(section).getAllByRole("listitem").filter(row => row.textContent?.includes("并列较低"));
  expect(lowRows.map(row => within(row).getByRole("meter").getAttribute("aria-label"))).toEqual(["技术深度", "完整度"]);
});

it("唯一最低维度获得相对标记，中间并列维度不会误标", async () => {
  const section = await showReview({ depth: 9.7, structure: 9.8, authenticity: 9.8, completeness: 10 });
  const low = within(section).getByText("相对较低", { exact: true }).closest("li")!;
  expect(low.textContent).toContain("技术深度");
  expect(section.textContent).toContain("均分最高的是完整度");
  expect(section.textContent).toContain("均分最低的是技术深度");
  expect(section.textContent).not.toMatch(/核心补强项|最需补强/);
});

it.each([false, true])("截断=%s 时统计卡均明确属于纳入范围，截断影响整页", async truncated => {
  await showReview({ depth: 7.4, structure: 7.4, authenticity: 7.4, completeness: 7.4 }, truncated);
  expect(screen.getByText("纳入统计的作答数").parentElement?.textContent).toContain(truncated ? "10002" : "5");
  expect(screen.getByText("本次统计综合均分").parentElement?.textContent).toContain("7.4");
  expect(screen.getByText("已评分练习场次").parentElement?.textContent).toContain("3");
  expect(screen.getByText("已评分面试场次").parentElement?.textContent).toContain("2");
  expect(screen.getByText("2 题已评分")).toBeDefined();
  expect(screen.queryByText(/全周期|累计评分题数|趋势图只显示/)).toBeNull();
  if (truncated) {
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("练习和面试各最多纳入 10,000 条");
    expect(notice.textContent).toContain("场次数、均分、趋势、维度分析和项目分布");
    expect(notice.textContent).toContain("部分场次可能只计入部分题目");
    expect(notice.textContent).toContain("其余记录仍保留");
  } else {
    expect(screen.queryByRole("status")).toBeNull();
  }
  expect(jsonFetch).toHaveBeenCalledTimes(1);
  expect(jsonFetch).toHaveBeenCalledWith("/api/review", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
});
