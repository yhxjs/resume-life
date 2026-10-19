"use client";

import Link from "next/link";
import { type FunnelInsight } from "@/lib/applications-types";

interface FunnelInsightsListProps {
  insights: FunnelInsight[];
}

export function FunnelInsightsList({ insights }: FunnelInsightsListProps) {
  if (!insights || insights.length === 0) {
    return null;
  }

  const severityConfigs = {
    warning: {
      badge: "需要优化",
      badgeCls: "bg-danger-wash text-danger border-danger/30",
      cardCls: "border-danger/30 bg-danger-wash/30",
      icon: "⚠️",
    },
    info: {
      badge: "状态提示",
      badgeCls: "bg-accent/15 text-accent border-accent/25",
      cardCls: "border-accent/25 bg-accent/5",
      icon: "💡",
    },
    success: {
      badge: "关键里程碑",
      badgeCls: "bg-primary-soft text-primary border-primary/30",
      cardCls: "border-primary/40 bg-primary-soft/30",
      icon: "🎯",
    },
  };

  return (
    <div className="rounded-2xl border border-line bg-card p-4 sm:p-5 shadow-card-subtle space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <span className="font-serif text-sm font-bold text-ink">
            求职漏斗智能洞察与策略指引
          </span>
          <span className="rounded-full bg-surface px-2 py-0.5 font-mono text-[11px] font-semibold text-muted border border-line">
            {insights.length} 条建议
          </span>
        </div>
        <span className="text-xs text-muted">
          基于当前求职转化率与各阶段积压情况的针对性建议
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {insights.map((item) => {
          const cfg = severityConfigs[item.severity] || severityConfigs.info;

          return (
            <div
              key={item.id}
              className={`flex flex-col justify-between rounded-xl border p-3.5 transition-all text-xs ${cfg.cardCls}`}
            >
              <div>
                {/* 顶部标题与等级标签 */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span>{cfg.icon}</span>
                    <h4 className="font-serif text-[13px] font-bold text-ink">
                      {item.title}
                    </h4>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.2 text-[10px] font-bold border shrink-0 ${cfg.badgeCls}`}
                  >
                    {cfg.badge}
                  </span>
                </div>

                {/* 描述文本 */}
                <p className="mt-2 text-muted leading-relaxed">
                  {item.description}
                </p>
              </div>

              {/* 底部指标高亮与行动按钮 */}
              <div className="mt-3 flex items-center justify-between pt-2 border-t border-line/40">
                <span className="font-mono font-bold text-ink text-[11px]">
                  {item.metricHighlight}
                </span>

                {item.actionText && item.actionHref && (
                  <Link
                    href={item.actionHref}
                    className="inline-flex items-center gap-1 rounded-md bg-card px-2.5 py-1 text-xs font-medium text-ink hover:bg-surface border border-line shadow-xs transition-colors"
                  >
                    <span>{item.actionText}</span>
                    <span aria-hidden>→</span>
                  </Link>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
