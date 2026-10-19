"use client";

import { type ApplicationViewMode } from "@/lib/applications-types";

interface ApplicationViewSwitcherProps {
  currentView: ApplicationViewMode;
  onViewChange: (view: ApplicationViewMode) => void;
  activeCount: number;
  upcomingInterviewCount: number;
  hasUrgentInterview: boolean;
  offerCount: number;
}

export function ApplicationViewSwitcher({
  currentView,
  onViewChange,
  activeCount,
  upcomingInterviewCount,
  hasUrgentInterview,
  offerCount,
}: ApplicationViewSwitcherProps) {
  const tabs: {
    id: ApplicationViewMode;
    label: string;
    icon: string;
    badge?: string | number;
    badgeCls?: string;
  }[] = [
    {
      id: "kanban",
      label: "看板模式",
      icon: "🗂️",
      badge: activeCount,
      badgeCls: "bg-surface text-muted border-line",
    },
    {
      id: "calendar",
      label: "日程日历",
      icon: "📅",
      badge: upcomingInterviewCount > 0 ? `${upcomingInterviewCount}场` : undefined,
      badgeCls: hasUrgentInterview
        ? "bg-danger text-on-danger font-bold animate-pulse"
        : "bg-accent/15 text-accent border-accent/20 font-bold",
    },
    {
      id: "funnel",
      label: "全周期漏斗",
      icon: "📊",
      badge: offerCount > 0 ? `${offerCount} Offer` : undefined,
      badgeCls: "bg-primary-soft text-primary border-primary/30 font-bold",
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="求职看板视图切换"
      className="inline-flex items-center rounded-xl border border-line bg-surface p-1 shadow-xs text-xs"
    >
      {tabs.map((tab) => {
        const isSelected = currentView === tab.id;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isSelected}
            type="button"
            onClick={() => onViewChange(tab.id)}
            className={`group relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-all ${
              isSelected
                ? "bg-card text-ink font-bold shadow-xs border border-line ring-1 ring-black/5"
                : "text-muted hover:text-ink hover:bg-card/60"
            }`}
          >
            <span aria-hidden="true" className="text-xs">
              {tab.icon}
            </span>
            <span>{tab.label}</span>

            {tab.badge !== undefined && (
              <span
                className={`ml-0.5 rounded-full px-1.5 py-0.2 font-mono text-[10px] border ${tab.badgeCls}`}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
