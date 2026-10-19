"use client";

import {
  APPLICATION_STAGES,
  STAGE_CONFIG,
  type ApplicationStage,
} from "@/lib/applications-types";

interface FunnelDistributionBarProps {
  counts: Record<ApplicationStage, number>;
  totalApplications: number;
}

export function FunnelDistributionBar({
  counts,
  totalApplications,
}: FunnelDistributionBarProps) {
  if (totalApplications === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-card-subtle space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="font-serif text-sm font-bold text-ink">
            求职阶段分布全景
          </span>
          <span className="text-xs text-muted">
            全流程共 <strong className="font-mono text-ink">{totalApplications}</strong> 份投递
          </span>
        </div>
        <span className="text-xs text-faint">基于当前跟踪状态的结构占比</span>
      </div>

      {/* 水平分段比例条 */}
      <div className="flex h-4 w-full overflow-hidden rounded-full bg-surface border border-line">
        {APPLICATION_STAGES.map((stage) => {
          const count = counts[stage] || 0;
          if (count === 0) return null;
          const percent = (count / totalApplications) * 100;
          const cfg = STAGE_CONFIG[stage];

          return (
            <div
              key={stage}
              style={{ width: `${percent}%` }}
              className={`h-full transition-all duration-300 ${cfg.dot}`}
              title={`${cfg.label}: ${count} 家 (${percent.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      {/* 图例徽章展示 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        {APPLICATION_STAGES.map((stage) => {
          const count = counts[stage] || 0;
          const percent =
            totalApplications > 0
              ? ((count / totalApplications) * 100).toFixed(0)
              : "0";
          const cfg = STAGE_CONFIG[stage];

          return (
            <div key={stage} className="flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot} shrink-0`} />
              <span className="text-muted font-medium">{cfg.label}</span>
              <span className="font-mono font-bold text-ink">{count}</span>
              <span className="text-[10px] text-faint font-mono">({percent}%)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
