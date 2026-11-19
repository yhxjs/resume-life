import { expect, it } from "vitest";
import { overallOf } from "../scores";
import { MAX_REVIEW_ANSWERS_PER_KIND, readReviewDashboard } from "../review-dashboard";
import { emptyReviewDashboardFixture, reviewDashboardFixture } from "../../../tests/support/review-dashboard";

type Fixture = ReturnType<typeof reviewDashboardFixture>;
it("读取保留合法小数、零负历史 ID、长文本和时间字面量，不改写输入", () => {
  const data = reviewDashboardFixture();
  data.sessions[0]!.label += "原文\n  <T> &amp; ".repeat(1000);
  data.projects[0]!.name += "项目原名".repeat(1000);
  const before = structuredClone(data);
  expect(readReviewDashboard(data)).toEqual(before);
  expect(data).toEqual(before);
  expect(readReviewDashboard(emptyReviewDashboardFixture())).toEqual(emptyReviewDashboardFixture());
});

const invalidCases: [string, (data: Fixture) => unknown][] = [
  ["非对象", () => []], ["缺少 totals", data => ({ ...data, totals: undefined })],
  ["数量字符串", data => ({ ...data, totals: { ...data.totals, scoredAnswers: "2" } })],
  ["数量负数", data => ({ ...data, totals: { ...data.totals, drills: -1 } })],
  ["数量小数", data => ({ ...data, totals: { ...data.totals, interviews: 0.5 } })],
  ["数量超预算", data => ({ ...data, totals: { ...data.totals, scoredAnswers: 20_001 } })],
  ["缺少截断标记", data => ({ ...data, truncated: undefined })],
  ["伪截断", data => ({ ...data, truncated: true })],
  ["场次非数组", data => ({ ...data, sessions: {} })],
  ["缺少场次", data => ({ ...data, sessions: [] })],
  ["重复场次", data => ({ ...data, sessions: [data.sessions[0], data.sessions[0]] })],
  ["来源错配", data => { data.sessions[0]!.id = "interview-0"; return data; }],
  ["伪造身份", data => { data.sessions[0]!.id = "drill-1e2"; return data; }],
  ["缺少日期", data => ({ ...data, sessions: [{ ...data.sessions[0], date: undefined }, data.sessions[1]] })],
  ["时间逆序", data => { data.sessions[0]!.date = "2026-11-02"; data.sessions[1]!.date = "2026-11-01"; return data; }],
  ["名称非文本", data => ({ ...data, sessions: [{ ...data.sessions[0], label: 1 }, data.sessions[1]] })],
  ["空场次", data => { data.sessions[0]!.count = 0; return data; }],
  ["作答数量不一致", data => { data.sessions[0]!.count = 2; return data; }],
  ["场次分数缺维", data => ({ ...data, sessions: [{ ...data.sessions[0], avg: { depth: 7 } }, data.sessions[1]] })],
  ["场次综合分错配", data => { data.sessions[0]!.overall = 1; return data; }],
  ["总分不一致", data => ({ ...data, overallScore: 0 })],
  ["总分字符串", data => ({ ...data, overallScore: String(data.overallScore) })],
  ["有作答却无总分", data => ({ ...data, overallScore: null })],
  ["来源均分缺失", data => ({ ...data, interviewAvg: null })],
  ["维度字符串", data => ({ ...data, overall: { ...data.overall, depth: "7.8" } })],
  ["维度越界", data => ({ ...data, overall: { ...data.overall, depth: 10.1 } })],
  ["维度非有限值", data => ({ ...data, overall: { ...data.overall, depth: NaN } })],
  ["项目非数组", data => ({ ...data, projects: null })],
  ["重复项目", data => ({ ...data, projects: [data.projects[0], data.projects[0]] })],
  ["项目数量超过练习作答", data => { data.projects[0]!.answers = 2; return data; }],
  ["项目无分", data => ({ ...data, projects: [{ ...data.projects[0], overall: null }] })],
  ["项目 ID 字符串", data => ({ ...data, projects: [{ ...data.projects[0], id: "0" }] })],
  ["无作答但有均分", () => ({ ...emptyReviewDashboardFixture(), overall: reviewDashboardFixture().overall })],
  ["无作答但有来源均分", () => ({ ...emptyReviewDashboardFixture(), drillAvg: reviewDashboardFixture().drillAvg })],
];
it.each(invalidCases)("%s 整页拒绝，不修补或过滤坏记录", (_label, change) => {
  expect(() => readReviewDashboard(change(reviewDashboardFixture()))).toThrow("复盘数据不完整或不一致");
});

it("允许后端按原答得到的均分，不用已舍入的场均分二次加权核对", () => {
  const data = reviewDashboardFixture();
  data.totals = { drills: 2, interviews: 0, scoredAnswers: 2 };
  const uniform = (value: number) => ({ depth: value, structure: value, authenticity: value, completeness: value });
  data.sessions = [7.4, 7.5].map((value, i) => ({ id: `drill-${i}`, kind: "drill", label: "", date: "旧日期", count: 1, avg: uniform(value), overall: value }));
  const payload = { ...data, overall: uniform(7.4), overallScore: 7.4, drillAvg: uniform(7.4), interviewAvg: null, projects: [] };
  expect(readReviewDashboard(payload)).toEqual(payload);
});

it("每类 10000 条／共 20000 场上限仍完整保留，任一来源越界整页拒绝", () => {
  const data = reviewDashboardFixture(), limit = MAX_REVIEW_ANSWERS_PER_KIND;
  data.totals = { drills: limit, interviews: limit, scoredAnswers: limit * 2 };
  data.truncated = true;
  data.projects = [];
  const originals = data.sessions;
  data.sessions = Array.from({ length: limit * 2 }, (_, i) => {
    const session = originals[i % 2]!;
    return { ...session, id: `${session.kind}-${i}`, overall: overallOf(session.avg) };
  });
  expect(readReviewDashboard(data).sessions).toHaveLength(20_000);
  data.sessions[0]!.count = 2;
  expect(() => readReviewDashboard(data)).toThrow("复盘数据不完整或不一致");
});
