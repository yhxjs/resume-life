"use client";

import { type FunnelMetrics } from "@/lib/applications-types";

interface FunnelMetricsSummaryProps {
  metrics: FunnelMetrics;
}

export function FunnelMetricsSummary({ metrics }: FunnelMetricsSummaryProps) {
  const {
    totalApplications,
    totalActive,
    totalOffers,
    totalRejected,
    totalCompleted,
    winRate,
    overallYieldRate,
  } = metrics;

  return (
    <section aria-label="投递统计概览" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {/* 总求职投递 */}
      <div className="rounded-xl border border-line bg-card p-3 shadow-card-subtle flex flex-col justify-between">
        <span className="text-xs text-muted">总跟进意向/投递</span>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="font-mono text-2xl font-bold text-ink tabular-nums">
            {totalApplications}
          </span>
          <span className="text-[10px] text-faint">条记录</span>
        </div>
      </div>

      {/* 进行中流程 */}
      <div className="rounded-xl border border-primary/30 bg-primary-soft/30 p-3 shadow-card-subtle flex flex-col justify-between">
        <span className="text-xs text-primary font-medium">进行中活跃流程</span>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="font-mono text-2xl font-bold text-primary tabular-nums">
            {totalActive}
          </span>
          <span className="text-[10px] text-primary/70">意向~待复盘</span>
        </div>
      </div>

      {/* 斩获 Offer */}
      <div className="rounded-xl border border-primary bg-card p-3 shadow-card-subtle flex flex-col justify-between ring-1 ring-primary/20">
        <span className="text-xs text-ink font-semibold flex items-center gap-1">
          <span>🎉 斩获 Offer</span>
        </span>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="font-mono text-2xl font-bold text-primary tabular-nums">
            {totalOffers}
          </span>
          <span className="text-[10px] text-muted">已通过</span>
        </div>
      </div>

      {/* 淘汰/终止 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 p-3 flex flex-col justify-between">
        <span className="text-xs text-muted">已终止流程</span>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="font-mono text-2xl font-bold text-muted tabular-nums">
            {totalRejected}
          </span>
          <span className="text-[10px] text-muted">已确认结束</span>
        </div>
      </div>

      {/* 只在已结束记录中计算 Offer 占比 */}
      <div className="rounded-xl border border-line bg-card p-3 shadow-card-subtle flex flex-col justify-between">
        <span className="text-xs text-muted">已结束记录 Offer 占比</span>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="font-mono text-2xl font-bold text-accent tabular-nums">
            {totalCompleted ? `${winRate}%` : "—"}
          </span>
          <span className="text-[10px] text-muted">{totalOffers} / {totalCompleted}</span>
        </div>
        <p className="mt-1 text-[10px] text-muted">Offer /（Offer + 终止）</p>
      </div>

      {/* 全部记录包含尚未投递的意向 */}
      <div className="rounded-xl border border-line bg-card p-3 shadow-card-subtle flex flex-col justify-between">
        <span className="text-xs text-muted">全部记录 Offer 占比</span>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="font-mono text-2xl font-bold text-ink tabular-nums">
            {totalApplications ? `${overallYieldRate}%` : "—"}
          </span>
          <span className="text-[10px] text-faint">
            {totalOffers} / {totalApplications}
          </span>
        </div>
        <p className="mt-1 text-[10px] text-muted">Offer / 全部记录（含意向）</p>
      </div>
      <p className="col-span-full text-xs leading-relaxed text-muted">按当前所选批次的意向／投递记录统计，同一企业的不同记录分别计数；“—”表示没有可计算的记录。</p>
    </section>
  );
}
