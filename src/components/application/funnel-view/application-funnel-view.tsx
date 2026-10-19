"use client";

import { useId, useState } from "react";
import { APPLICATION_TERMINAL_STAGE_CONFIG, type FunnelBatchMetric, type FunnelMetrics } from "@/lib/applications-types";
import { inputCls } from "@/lib/ui";
import { FunnelMetricsSummary } from "./funnel-metrics-summary";
import { FunnelStepChart } from "./funnel-step-chart";
import { FunnelDistributionBar } from "./funnel-distribution-bar";
import { FunnelInsightsList } from "./funnel-insights-list";

interface ApplicationFunnelViewProps {
  metrics: FunnelMetrics;
  batches: FunnelBatchMetric[];
}

export function ApplicationFunnelView({ metrics: allMetrics, batches }: ApplicationFunnelViewProps) {
  const filterId = useId();
  const [selectedBatch, setSelectedBatch] = useState("all");
  const batch = batches.find(item => JSON.stringify(item.batchName) === selectedBatch);
  const metrics = batch ?? allMetrics;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor={filterId} className="text-sm font-medium text-ink">投递批次</label>
          <select id={filterId} className={`${inputCls} w-auto max-w-64`} value={batch ? selectedBatch : "all"} onChange={e => setSelectedBatch(e.target.value)}>
            <option value="all">全部批次</option>
            {batches.map(item => <option key={item.batchName} value={JSON.stringify(item.batchName)}>{item.batchName || "未分批（未填写）"}</option>)}
          </select>
        </div>
        <p className="text-xs text-muted">统计覆盖完整批次，不受看板分页、搜索和阶段筛选影响。</p>
      </div>
      {metrics.totalApplications === 0 && <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">暂无投递记录，登记投递后即可查看阶段结果。</p>}
      <FunnelMetricsSummary metrics={metrics} />
      <section className="rounded-2xl border border-line bg-card p-4 sm:p-5">
        <h3 className="font-serif text-base font-bold text-ink">招聘环节结果</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">通过率 = 已通过 /（已通过 + 已终止）。进行中仍未结算，不计入流失；进入后续招聘环节或收到 Offer 表示通过当前环节。</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[460px] text-right text-sm">
            <thead className="border-b border-line text-xs text-muted"><tr>
              <th scope="col" className="py-2 text-left">招聘环节</th><th scope="col">进行中</th><th scope="col">已通过</th><th scope="col">已终止</th><th scope="col">已结算通过率</th>
            </tr></thead>
            <tbody>{metrics.hiringSteps.map(step => <tr key={step.stage} className="border-b border-line/60">
              <th scope="row" className="py-3 text-left font-medium text-ink">{step.label}</th>
              <td className="font-mono text-ink">{step.active}</td><td className="font-mono text-primary">{step.passed}</td>
              <td className="font-mono text-muted">{step.terminated}</td><td className="font-mono">{step.conversionRate === null ? "— 未结算" : `${step.conversionRate}%`}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">各环节按投递去重；同一投递可在前一环节已通过、后一环节进行中。回退或重开后以最新记录为准。</p>
        <p className="mt-2 text-xs text-muted">尚未进入或未记录招聘环节：{metrics.totalActive - metrics.hiringSteps.reduce((total, step) => total + step.active, 0)} 份进行中记录，可在投递编辑中补充。</p>
        {(metrics.incompleteHistoryCount > 0 || metrics.unknownTerminations > 0) && <p className="mt-2 text-xs text-muted">
          {metrics.incompleteHistoryCount} 份投递的历史记录不完整；{metrics.unknownTerminations} 份终止记录的归因未知。仅统计已记录的环节，不推算历史时间或未记录的通过结果。
        </p>}
      </section>
      <FunnelStepChart steps={metrics.steps} totalRejected={metrics.totalRejected} totalApplications={metrics.totalApplications} />
      {batches.length > 0 && <section className="rounded-2xl border border-line bg-card p-4">
        <h3 className="font-serif text-base font-bold text-ink">批次对比</h3>
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[460px] text-right text-sm">
          <thead className="border-b border-line text-xs text-muted"><tr><th className="py-2 text-left" scope="col">批次</th><th scope="col">总数</th><th scope="col">进行中</th><th scope="col">已通过 / Offer</th><th scope="col">已终止</th></tr></thead>
          <tbody>{batches.map(item => <tr key={item.batchName} className="border-b border-line/60"><th scope="row" className="max-w-52 break-words py-3 text-left font-medium">{item.batchName || "未分批（未填写）"}</th><td>{item.totalApplications}</td><td>{item.totalActive}</td><td>{item.totalOffers}</td><td>{item.totalRejected}</td></tr>)}</tbody>
        </table></div>
      </section>}
      {metrics.terminationReasons.length > 0 && <section className="rounded-2xl border border-line bg-card p-4">
        <h3 className="font-serif text-base font-bold text-ink">终止原因</h3>
        <ul className="mt-3 space-y-2 text-sm">{metrics.terminationReasons.map(item => <li key={JSON.stringify([item.stage, item.reason])} className="flex justify-between gap-4 border-b border-line/60 pb-2">
          <span className="min-w-0 break-words">{item.stage ? APPLICATION_TERMINAL_STAGE_CONFIG[item.stage].label : "阶段未知"} · {item.reason}</span><span className="shrink-0 font-mono text-muted">{item.count} 份</span>
        </li>)}</ul>
      </section>}
      <FunnelDistributionBar counts={metrics.counts} totalApplications={metrics.totalApplications} />
      <FunnelInsightsList insights={metrics.insights} />
    </div>
  );
}
