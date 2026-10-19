"use client";

import { useMemo, useState } from "react";
import {
  type CalendarInterviewEvent,
  type InterviewRoundStatus,
} from "@/lib/applications-types";
import { CalendarInterviewCard } from "./calendar-interview-card";

interface AgendaListViewProps {
  events: CalendarInterviewEvent[];
  currentTime: number;
  onEditRound?: (event: CalendarInterviewEvent) => void;
  onQuickStatusChange?: (
    applicationId: number,
    roundId: number,
    status: InterviewRoundStatus
  ) => void;
}

export function AgendaListView({
  events,
  currentTime,
  onEditRound,
  onQuickStatusChange,
}: AgendaListViewProps) {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showPastEvents, setShowPastEvents] = useState(false);

  const filteredEvents = useMemo(() => {
    if (statusFilter === "all") return events;
    return events.filter((e) => e.status === statusFilter);
  }, [events, statusFilter]);

  // 将事件按「待面试/未完成」与「已结束/历史记录」分类
  const { upcomingList, pastList } = useMemo(() => {
    const now = currentTime || 0;
    const upcoming: CalendarInterviewEvent[] = [];
    const past: CalendarInterviewEvent[] = [];

    for (const evt of filteredEvents) {
      const time = new Date(evt.interview_time).getTime();
      // 如果还没取得客户端时间（now=0），暂时都归入 upcoming 待挂载
      if (evt.status === "scheduled" && (now === 0 || time >= now - 1000 * 60 * 60 * 2)) {
        upcoming.push(evt);
      } else {
        past.push(evt);
      }
    }

    return { upcomingList: upcoming, pastList: past };
  }, [filteredEvents, currentTime]);

  const statusOptions: { key: string; label: string }[] = [
    { key: "all", label: "全部日程" },
    { key: "scheduled", label: "待面试" },
    { key: "passed", label: "已通过" },
    { key: "completed", label: "已完成" },
    { key: "failed", label: "未通过" },
  ];

  return (
    <div className="space-y-4">
      {/* 顶部过滤药丸 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-card p-3 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted mr-1 font-medium">状态筛选:</span>
          {statusOptions.map((opt) => {
            const isSelected = statusFilter === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setStatusFilter(opt.key)}
                className={`rounded-lg px-2.5 py-1 font-medium transition-all ${
                  isSelected
                    ? "bg-primary text-on-primary shadow-xs"
                    : "bg-surface text-muted hover:text-ink hover:bg-surface-2"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <span className="text-muted">
          共找到 <strong className="font-mono text-ink">{filteredEvents.length}</strong> 场排期
        </span>
      </div>

      {/* 待办面试时间线 */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 border-b border-line pb-2">
          <span className="h-2 w-2 rounded-full bg-accent" />
          <h3 className="font-serif text-sm font-bold text-ink">
            待进行面试 ({upcomingList.length})
          </h3>
        </div>

        {upcomingList.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcomingList.map((evt) => (
              <CalendarInterviewCard
                key={`${evt.application_id}-${evt.id}`}
                event={evt}
                currentTime={currentTime}
                onEditRound={onEditRound}
                onQuickStatusChange={onQuickStatusChange}
              />
            ))}
          </div>
        ) : (
          <div className="flex h-28 flex-col items-center justify-center rounded-xl border border-dashed border-line text-xs text-faint">
            <span>当前无待进行的面试排期</span>
          </div>
        )}
      </div>

      {/* 历史面试记录（可折叠） */}
      <div className="rounded-2xl border border-line/60 bg-surface/40 p-4">
        <button
          type="button"
          onClick={() => setShowPastEvents((v) => !v)}
          className="flex w-full items-center justify-between text-left text-xs font-medium text-muted hover:text-ink"
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-faint" />
            <span className="font-serif text-sm font-bold text-ink">
              历史面试记录 ({pastList.length})
            </span>
            <span className="text-[11px] text-faint">已完成、通过或往期排期记录</span>
          </div>
          <span>{showPastEvents ? "▲ 收起" : "▼ 展开查看"}</span>
        </button>

        {showPastEvents && (
          <div className="mt-3 pt-3 border-t border-line/50 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pastList.map((evt) => (
              <CalendarInterviewCard
                key={`${evt.application_id}-${evt.id}`}
                event={evt}
                currentTime={currentTime}
                onEditRound={onEditRound}
                onQuickStatusChange={onQuickStatusChange}
              />
            ))}
            {pastList.length === 0 && (
              <p className="text-xs text-faint col-span-full py-4 text-center">
                暂无历史记录
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
