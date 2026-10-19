"use client";

import { FUNNEL_STAGES, STAGE_CONFIG, type ApplicationStats } from "@/lib/applications-types";

interface FunnelStripProps {
  stats: ApplicationStats;
  selectedStage?: string;
  onSelectStage?: (stage: string) => void;
}

export function FunnelStrip({ stats, selectedStage = "all", onSelectStage }: FunnelStripProps) {
  const { counts, rates } = stats;
  const appliedRate = stats.funnel ? stats.funnel.steps.find(s => s.stage === "interested")?.conversionRate : rates.appliedRate;
  const screeningRate = stats.funnel ? stats.funnel.hiringSteps.find(s => s.stage === "resume_screening")?.conversionRate : rates.interviewRate;
  const offerRate = stats.funnel ? stats.funnel.totalCompleted ? stats.funnel.winRate : null : rates.offerRate;
  const displayRate = (rate: number | null | undefined) => rate == null ? "—" : `${rate}%`;

  return (
    <div className="rounded-2xl border border-line bg-card p-4 sm:p-5 shadow-card-subtle space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="font-serif text-sm font-bold text-ink">求职漏斗转化概览</span>
          <span className="text-xs text-muted">
            进行中投递: <strong className="font-mono text-ink">{stats.totalActive}</strong> 家
          </span>
        </div>

        {/* 转化率指标微标签 */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted">
          <span>
            已结算投递推进率: <strong className="font-mono text-ink">{displayRate(appliedRate)}</strong>
          </span>
          <span className="text-line-strong">·</span>
          <span>
            已结算简历通过率: <strong className="font-mono text-accent">{displayRate(screeningRate)}</strong>
          </span>
          <span className="text-line-strong">·</span>
          <span>
            已结束流程 Offer 率: <strong className="font-mono text-primary font-bold">{displayRate(offerRate)}</strong>
          </span>
        </div>
      </div>

      {/* 6 阶段流转步骤条 + 终止分支 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7 sm:gap-2.5">
        {FUNNEL_STAGES.map((stageKey, idx) => {
          const cfg = STAGE_CONFIG[stageKey];
          const count = counts[stageKey] || 0;
          const isSelected = selectedStage === stageKey;

          return (
            <button
              key={stageKey}
              type="button"
              onClick={() => onSelectStage?.(isSelected ? "all" : stageKey)}
              className={`group flex flex-col justify-between rounded-xl border p-2.5 text-left transition-all duration-150 ${
                isSelected
                  ? "border-primary bg-primary-soft/40 shadow-xs ring-1 ring-primary/20"
                  : "border-line bg-surface hover:border-line-strong hover:bg-card"
              }`}
            >
              <div className="flex items-center justify-between gap-1 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-muted group-hover:text-ink">
                  <span className={`h-2 w-2 rounded-full ${cfg.dot}`} />
                  <span>{cfg.label}</span>
                </span>
                <span className="text-[10px] text-faint font-mono">0{idx + 1}</span>
              </div>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="font-serif text-2xl font-bold text-ink font-mono tabular-nums">
                  {count}
                </span>
                <span className="text-[10px] text-muted">{cfg.desc}</span>
              </div>
            </button>
          );
        })}

        {/* 流程终止分支卡片 */}
        <button
          type="button"
          onClick={() => onSelectStage?.(selectedStage === "rejected" ? "all" : "rejected")}
          className={`flex flex-col justify-between rounded-xl border p-2.5 text-left transition-all duration-150 ${
            selectedStage === "rejected"
              ? "border-line-strong bg-surface-2 shadow-xs ring-1 ring-black/10"
              : "border-line/60 bg-surface-2/40 hover:border-line hover:bg-surface-2"
          }`}
        >
          <div className="flex items-center justify-between gap-1 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-faint">
              <span className="h-2 w-2 rounded-full bg-faint" />
              <span>流程终止</span>
            </span>
            <span className="text-[10px] text-faint font-mono">End</span>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-serif text-2xl font-bold text-muted font-mono tabular-nums">
              {counts.rejected || 0}
            </span>
            <span className="text-[10px] text-faint">不合适/已挂</span>
          </div>
        </button>
      </div>
    </div>
  );
}
