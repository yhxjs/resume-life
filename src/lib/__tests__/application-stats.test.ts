import { expect, it } from "vitest";
import { readApplicationStats, type ApplicationStatsSnapshot } from "../application-stats";
import type { ApplicationStage, FunnelApplication } from "../applications-types";
import { applicationStatsFixture } from "../../../tests/support/application-stats";

const app = (id: number, stage: ApplicationStage, batch_name = ""): FunnelApplication => ({
  id, stage, batch_name, hiring_stage: stage === "applied" ? "resume_screening" : null,
  terminal_stage: stage === "rejected" ? "technical_interview" : null,
  terminal_reason: stage === "rejected" ? "保留 <T> &amp; 原因\n " + "旧记录_".repeat(80) : "", stage_history: [],
});
const sample = (): ApplicationStatsSnapshot => applicationStatsFixture([app(0, "offer", " A <T> "), app(-2, "rejected", "B"), app(3, "rejected", "B"), app(4, "applied")]);

it("整份保留合法快照和历史文字，批次比例不平均，零与无分母按原值保留", () => {
  const data = sample(), before = structuredClone(data);
  expect(readApplicationStats(data)).toBe(data);
  expect(data).toEqual(before);
  expect(data.funnel.winRate).toBe(33);
  expect(data.batchStats.map(batch => batch.winRate)).toEqual([100, 0, 0]);
  expect(data.funnel.hiringSteps[0]!.conversionRate).toBeNull();
  expect(data.funnel.hiringSteps[1]!.conversionRate).toBe(0);
  expect(readApplicationStats(applicationStatsFixture()).funnel.totalApplications).toBe(0);
});

it("日程允许零／负 ID、旧日期和带时区日期；Offer 日程不受进行中数量限制", () => {
  const data: ApplicationStatsSnapshot = applicationStatsFixture([app(0, "offer"), app(-1, "offer")]);
  data.upcomingInterviews = [
    { id: 0, company: "旧记录 <T> &amp;\n", role: "", jd: "", next_interview_at: "2001-01-01T00:00:00Z" },
    { id: -1, company: "", role: "历史岗位", jd: "JD\n", next_interview_at: "2026-11-03T15:20:00+08:00" },
  ];
  expect(data.totalActive).toBe(0);
  expect(readApplicationStats(data).upcomingInterviews).toEqual(data.upcomingInterviews);
});

it("历史缺失、未知终止归因和未分批均可读取", () => {
  const legacy = { ...app(-2, "rejected"), terminal_stage: null, terminal_reason: "", stage_history: undefined };
  const data = applicationStatsFixture([legacy]);
  expect(readApplicationStats(data).funnel).toMatchObject({ unknownTerminations: 1, incompleteHistoryCount: 1 });
});

const changes: [string, string, unknown][] = [
  ["缺少漏斗", "funnel", undefined],
  ["伪空顶层", "counts", {}],
  ["缺少日程数组", "upcomingInterviews", null],
  ["缺少批次数组", "batchStats", undefined],
  ["丢失所有批次", "batchStats", []],
  ["批次漏一阶段", "batchStats.0.steps", []],
  ["计数是字符串", "counts.offer", "1"],
  ["顶层与漏斗矛盾", "totalActive", 99],
  ["总量小数", "funnel.totalApplications", 4.5],
  ["总量负数", "funnel.totalApplications", -1],
  ["不安全整数", "funnel.totalApplications", Number.MAX_SAFE_INTEGER + 1],
  ["计数无穷大", "funnel.counts.interested", Infinity],
  ["丢失总量", "funnel.totalApplications", undefined],
  ["已结束分母错误", "funnel.totalCompleted", 4],
  ["Offer 重复计数", "funnel.totalOffers", 2],
  ["错误整数比例", "funnel.winRate", 34],
  ["非有限比例", "funnel.overallYieldRate", NaN],
  ["顶层采用旧版比例", "rates.offerRate", 100],
  ["缺少嵌套数组", "funnel.hiringSteps", undefined],
  ["阶段顺序错乱", "funnel.steps.0.stage", "applied"],
  ["待处理数不一致", "funnel.steps.1.count", 2],
  ["累计数不一致", "funnel.steps.1.cumulativeCount", 0],
  ["无分母伪装零比例", "funnel.steps.0.conversionRate", 0],
  ["环节非法", "funnel.hiringSteps.0.stage", "screening"],
  ["环节活动数量溢出", "funnel.hiringSteps.0.active", 4],
  ["有终止却无比例", "funnel.hiringSteps.1.conversionRate", null],
  ["历史缺失量溢出", "funnel.incompleteHistoryCount", 5],
  ["未知终止量矛盾", "funnel.unknownTerminations", 1],
  ["丢失终止原因", "funnel.terminationReasons", []],
  ["原因非文本", "funnel.terminationReasons.0.reason", {}],
  ["原因阶段非法", "funnel.terminationReasons.0.stage", "constructor"],
  ["原因计数错误", "funnel.terminationReasons.0.count", 1],
  ["建议非数组", "funnel.insights", {}],
  ["建议标题非文本", "funnel.insights.0.title", {}],
  ["建议级别非法", "funnel.insights.0.severity", "constructor"],
  ["建议链接非法", "funnel.insights.0.actionHref", "javascript:alert(1)"],
];
it.each(changes)("拒绝整个异常快照：%s", (_name, key, value) => {
  const data = sample();
  const parts = key.split("."), last = parts.pop()!;
  let target: unknown = data;
  for (const part of parts) target = (target as Record<string, unknown>)[part];
  (target as Record<string, unknown>)[last] = value;
  expect(() => readApplicationStats(data)).toThrow("投递统计不完整或不一致");
});

it("拒绝内部各自合法但未覆盖全量的批次，以及重复批次／建议／终止原因", () => {
  for (const change of [
    (data: ApplicationStatsSnapshot) => { data.batchStats = applicationStatsFixture([app(99, "applied", "A")]).batchStats; },
    (data: ApplicationStatsSnapshot) => { data.batchStats.push(data.batchStats[0]!); },
    (data: ApplicationStatsSnapshot) => { data.funnel.insights.push(data.funnel.insights[0]!); },
    (data: ApplicationStatsSnapshot) => { data.funnel.terminationReasons.push(data.funnel.terminationReasons[0]!); },
  ]) {
    const data = sample(); change(data);
    expect(() => readApplicationStats(data)).toThrow("投递统计不完整或不一致");
  }
});

it.each([{}, { id: "1" }, { id: 1.2 }, { company: {} }, { role: null }, { jd: [] }, { next_interview_at: "not-a-date" }])("拒绝损坏的日程项 %j", patch => {
  const data = sample();
  const item = { id: 1, company: "公司", role: "岗位", jd: "", next_interview_at: "2026-11-03T00:00:00Z" };
  Reflect.set(data, "upcomingInterviews", [Object.keys(patch).length ? { ...item, ...patch } : {}]);
  expect(() => readApplicationStats(data)).toThrow("投递统计不完整或不一致");
});

it("拒绝重复日程及超出非终止记录数量的日程", () => {
  const data = sample();
  const item = { id: 1, company: "公司", role: "岗位", jd: "", next_interview_at: "2026-11-03T00:00:00Z" };
  data.upcomingInterviews = [item, item];
  expect(() => readApplicationStats(data)).toThrow("投递统计不完整或不一致");
  data.upcomingInterviews = [item, { ...item, id: 2 }, { ...item, id: 3 }];
  expect(() => readApplicationStats(data)).toThrow("投递统计不完整或不一致");
});
