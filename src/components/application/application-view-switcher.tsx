"use client";

import { useId, useRef } from "react";
import { type ApplicationViewMode } from "@/lib/applications-types";

interface ApplicationViewSwitcherProps {
  id?: string;
  currentView: ApplicationViewMode;
  onViewChange: (view: ApplicationViewMode) => void;
  activeCount: number | null;
  upcomingInterviewCount: number | null;
  hasUrgentInterview: boolean;
  offerCount: number | null;
}

export function ApplicationViewSwitcher({
  id,
  currentView,
  onViewChange,
  activeCount,
  upcomingInterviewCount,
  hasUrgentInterview,
  offerCount,
}: ApplicationViewSwitcherProps) {
  const generatedId = useId();
  const prefix = id ?? generatedId;
  const buttons = useRef<Partial<Record<ApplicationViewMode, HTMLButtonElement | null>>>({});
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
      badge: activeCount ?? undefined,
      badgeCls: "bg-surface text-muted border-line",
    },
    {
      id: "calendar",
      label: "日程日历",
      icon: "📅",
      badge: upcomingInterviewCount !== null && upcomingInterviewCount > 0 ? upcomingInterviewCount : undefined,
      badgeCls: hasUrgentInterview
        ? "bg-danger text-on-danger font-bold animate-pulse"
        : "bg-accent/15 text-accent border-accent/20 font-bold",
    },
    {
      id: "funnel",
      label: "全周期漏斗",
      icon: "📊",
      badge: offerCount !== null && offerCount > 0 ? offerCount : undefined,
      badgeCls: "bg-primary-soft text-primary border-primary/30 font-bold",
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="求职看板视图切换"
      className="inline-flex items-center rounded-xl border border-line bg-surface p-1 shadow-xs text-xs"
    >
      {tabs.map((tab, index) => {
        const isSelected = currentView === tab.id;

        return (
          <button
            key={tab.id}
            id={`${prefix}-${tab.id}`}
            ref={element => { buttons.current[tab.id] = element; }}
            role="tab"
            aria-selected={isSelected}
            aria-controls={`${prefix}-panel`}
            tabIndex={isSelected ? 0 : -1}
            type="button"
            onClick={() => onViewChange(tab.id)}
            onKeyDown={event => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              const target = tabs[next]!;
              buttons.current[target.id]?.focus();
              onViewChange(target.id);
            }}
            className={`group relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg py-1.5 font-medium transition-all ${
              isSelected
                ? "bg-card text-ink font-bold shadow-xs border border-line ring-1 ring-black/5"
                : "text-muted hover:text-ink hover:bg-card/60"
            }`}
            style={{ paddingInline: "8px" }}
          >
            <span aria-hidden="true" className="text-xs">
              {tab.icon}
            </span>
            <span className="whitespace-nowrap">{tab.label}</span>

            {tab.badge !== undefined && (
              <span
                className={`ml-0.5 shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.2 font-mono text-[10px] border ${tab.badgeCls}`}
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
