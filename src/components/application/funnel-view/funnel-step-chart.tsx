"use client";

import { STAGE_CONFIG, type FunnelStepMetric } from "@/lib/applications-types";

interface FunnelStepChartProps {
  steps: FunnelStepMetric[];
  totalRejected: number;
  totalApplications: number;
}

export function FunnelStepChart({ steps, totalRejected, totalApplications }: FunnelStepChartProps) {
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-card p-4 sm:p-5">
      <h3 className="font-serif text-base font-bold text-ink">全周期求职转化漏斗 · 阶段履历</h3>
      <p className="text-xs text-muted">按真实到访记录统计看板推进，跳过的阶段不补计；招聘考核是否通过请查看上方招聘环节结果。</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-right text-sm">
          <thead className="border-b border-line text-xs text-muted"><tr>
            <th scope="col" className="py-2 text-left">看板阶段</th><th scope="col">已到达</th><th scope="col">进行中</th><th scope="col">已推进</th><th scope="col">已终止</th><th scope="col">回退 / 待补充</th>
          </tr></thead>
          <tbody>{steps.map(step => <tr key={step.stage} className="border-b border-line/60">
            <th scope="row" className="py-3 text-left font-medium"><span className={`mr-2 inline-block h-2 w-2 rounded-full ${STAGE_CONFIG[step.stage].dot}`} />{step.label}</th>
            <td>{step.cumulativeCount}</td><td>{step.count}</td><td>{step.passedCount}</td><td>{step.dropOffCount}</td><td>{step.unknownCount}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p className="text-xs text-muted">共 {totalApplications} 份投递，确认终止 {totalRejected} 份；流失数仅包含确认终止，历史终止阶段未知的记录不强行分配到某列。</p>
    </section>
  );
}
