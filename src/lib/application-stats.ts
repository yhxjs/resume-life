import {
  APPLICATION_STAGES, APPLICATION_TERMINAL_STAGES, FUNNEL_STAGES,
  type Application, type ApplicationStats, type FunnelBatchMetric, type FunnelMetrics,
} from "./applications-types";

export type UpcomingApplication = Pick<Application, "id" | "company" | "role" | "jd" | "next_interview_at">;
export type ApplicationStatsSnapshot = Pick<ApplicationStats, "counts" | "totalActive" | "rates"> & {
  upcomingInterviews: UpcomingApplication[];
  funnel: FunnelMetrics;
  batchStats: FunnelBatchMetric[];
};

function invalid(): never { throw new Error("投递统计不完整或不一致，请重新读取"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value; }
function text(value: unknown): string { if (typeof value !== "string") invalid(); return value; }
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) invalid();
  return value;
}
function equal(actual: unknown, expected: number | null) { if (actual !== expected) invalid(); }
function rate(numerator: number, denominator: number) { return denominator ? Math.round(numerator / denominator * 100) : null; }
const stepCounts = ["count", "cumulativeCount", "passedCount", "unknownCount", "dropOffCount"] as const;
const hiringCounts = ["active", "passed", "terminated"] as const;
const totals = ["totalApplications", "totalActive", "totalCompleted", "totalOffers", "totalRejected", "unknownTerminations", "incompleteHistoryCount"] as const;

function readMetrics(value: unknown): FunnelMetrics {
  const data = record(value), counts = record(data.counts);
  const total = count(data.totalApplications);
  for (const key of totals) count(data[key], total);
  for (const stage of APPLICATION_STAGES) count(counts[stage], total);
  equal(total, APPLICATION_STAGES.reduce((sum, stage) => sum + (counts[stage] as number), 0));
  equal(data.totalOffers, counts.offer as number);
  equal(data.totalRejected, counts.rejected as number);
  equal(data.totalCompleted, (counts.offer as number) + (counts.rejected as number));
  equal(data.totalActive, total - (data.totalCompleted as number));
  equal(data.winRate, rate(data.totalOffers as number, data.totalCompleted as number) ?? 0);
  equal(data.overallYieldRate, rate(data.totalOffers as number, total) ?? 0);

  const steps = list(data.steps), hiring = list(data.hiringSteps);
  if (steps.length !== FUNNEL_STAGES.length || hiring.length !== APPLICATION_TERMINAL_STAGES.length) invalid();
  steps.forEach((value, index) => {
    const step = record(value);
    if (step.stage !== FUNNEL_STAGES[index]) invalid();
    text(step.label); text(step.desc);
    for (const key of stepCounts) count(step[key], total);
    equal(step.count, step.stage === "offer" ? 0 : counts[step.stage as string] as number);
    const settled = (step.passedCount as number) + (step.dropOffCount as number);
    equal(step.cumulativeCount, (step.count as number) + (step.unknownCount as number) + settled);
    equal(step.conversionRate, rate(step.passedCount as number, settled));
    equal(step.dropOffRate, rate(step.dropOffCount as number, settled));
  });
  let active = 0;
  hiring.forEach((value, index) => {
    const step = record(value);
    if (step.stage !== APPLICATION_TERMINAL_STAGES[index]) invalid();
    text(step.label);
    for (const key of hiringCounts) count(step[key], total);
    const settled = (step.passed as number) + (step.terminated as number);
    count((step.active as number) + settled, total);
    equal(step.conversionRate, rate(step.passed as number, settled));
    active += step.active as number;
  });
  count(active, data.totalActive as number);

  const reasons = list(data.terminationReasons), seenReasons = new Set<string>();
  let rejected = 0, unknown = 0;
  for (const value of reasons) {
    const item = record(value);
    if (item.stage !== null && !APPLICATION_TERMINAL_STAGES.some(stage => stage === item.stage)) invalid();
    text(item.reason);
    const amount = count(item.count, data.totalRejected as number);
    const key = JSON.stringify([item.stage, item.reason]);
    if (!amount || seenReasons.has(key)) invalid();
    seenReasons.add(key); rejected += amount;
    if (item.stage === null) unknown += amount;
  }
  equal(rejected, data.totalRejected as number); equal(unknown, data.unknownTerminations as number);
  const seenInsights = new Set<string>();
  for (const value of list(data.insights)) {
    const item = record(value), id = text(item.id);
    if (seenInsights.has(id) || !["info", "warning", "success"].includes(item.severity as string)) invalid();
    seenInsights.add(id);
    for (const key of ["title", "description", "metricHighlight"]) text(item[key]);
    if (item.actionText !== undefined) text(item.actionText);
    if (item.actionHref !== undefined && !/^\/(?![/\\])[^\\\s]*$/.test(text(item.actionHref))) invalid();
  }
  return value as FunnelMetrics;
}

/**
 * 校验整份用于显示的统计，不补零、不丢弃坏项。批次计数可相加，百分比必须
 * 各自按原分母核对，不能平均批次百分比。历史文本与合法零／负 ID 原样保留；
 * 日程只校验可解析的原日期，不用客户端当前时刻拒绝刚过期的服务端快照。
 */
export function readApplicationStats(value: unknown): ApplicationStatsSnapshot {
  const data = record(value), funnel = readMetrics(data.funnel), counts = record(data.counts), rates = record(data.rates);
  for (const stage of APPLICATION_STAGES) equal(counts[stage], funnel.counts[stage]);
  equal(data.totalActive, funnel.totalActive);
  equal(rates.appliedRate, funnel.steps[0]!.conversionRate ?? 0);
  equal(rates.interviewRate, funnel.hiringSteps[0]!.conversionRate ?? 0);
  equal(rates.offerRate, funnel.winRate);

  const seenBatches = new Set<string>();
  const batches = list(data.batchStats).map(value => {
    const batch = readMetrics(value) as FunnelBatchMetric;
    const name = text(batch.batchName);
    if (!batch.totalApplications || seenBatches.has(name)) invalid();
    seenBatches.add(name);
    return batch;
  });
  for (const key of totals) equal(batches.reduce((sum, batch) => sum + batch[key], 0), funnel[key]);
  for (const stage of APPLICATION_STAGES) equal(batches.reduce((sum, batch) => sum + batch.counts[stage], 0), funnel.counts[stage]);
  funnel.steps.forEach((step, index) => {
    for (const key of stepCounts) equal(batches.reduce((sum, batch) => sum + batch.steps[index]![key], 0), step[key]);
  });
  funnel.hiringSteps.forEach((step, index) => {
    for (const key of hiringCounts) equal(batches.reduce((sum, batch) => sum + batch.hiringSteps[index]![key], 0), step[key]);
  });
  const batchReasons = new Map<string, number>();
  for (const batch of batches) for (const item of batch.terminationReasons) {
    const key = JSON.stringify([item.stage, item.reason]);
    batchReasons.set(key, (batchReasons.get(key) ?? 0) + item.count);
  }
  if (batchReasons.size !== funnel.terminationReasons.length) invalid();
  for (const item of funnel.terminationReasons) equal(batchReasons.get(JSON.stringify([item.stage, item.reason])), item.count);

  const seenInterviews = new Set<number>();
  const upcoming = list(data.upcomingInterviews);
  if (upcoming.length > funnel.totalApplications - funnel.totalRejected) invalid();
  for (const value of upcoming) {
    const app = record(value);
    if (typeof app.id !== "number" || !Number.isSafeInteger(app.id) || seenInterviews.has(app.id)) invalid();
    seenInterviews.add(app.id);
    for (const key of ["company", "role", "jd"]) text(app[key]);
    if (!Number.isFinite(Date.parse(text(app.next_interview_at)))) invalid();
  }
  return value as ApplicationStatsSnapshot;
}
