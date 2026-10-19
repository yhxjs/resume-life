"use client";

import {
  isSameDay,
  toDayKey,
} from "@/lib/application-calendar";
import {
  type CalendarInterviewEvent,
  type InterviewRoundStatus,
} from "@/lib/applications-types";
import { CalendarInterviewCard } from "./calendar-interview-card";

interface WeekCalendarGridProps {
  weekDays: Date[];
  currentTime: number;
  eventsByDay: Map<string, CalendarInterviewEvent[]>;
  onEditRound?: (event: CalendarInterviewEvent) => void;
  onQuickStatusChange?: (
    applicationId: number,
    roundId: number,
    status: InterviewRoundStatus
  ) => void;
  onQuickAddSchedule?: (day: Date) => void;
}

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function WeekCalendarGrid({
  weekDays,
  currentTime,
  eventsByDay,
  onEditRound,
  onQuickStatusChange,
  onQuickAddSchedule,
}: WeekCalendarGridProps) {
  const todayDate = currentTime ? new Date(currentTime) : null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7 items-start">
      {weekDays.map((day, idx) => {
        const dayKey = toDayKey(day);
        const dayEvents = eventsByDay.get(dayKey) || [];
        const isToday = todayDate ? isSameDay(day, todayDate) : false;
        const weekdayName = WEEKDAY_NAMES[idx];
        const dateNum = day.getDate();

        return (
          <div
            key={dayKey}
            className={`flex flex-col rounded-2xl border transition-colors min-h-[380px] p-2.5 ${
              isToday
                ? "border-primary/50 bg-primary-soft/20 shadow-xs ring-1 ring-primary/20"
                : "border-line bg-surface/50"
            }`}
          >
            {/* 星期与日期列头部 */}
            <div
              className={`flex items-center justify-between pb-2 mb-2.5 border-b ${
                isToday ? "border-primary/30" : "border-line"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full font-mono text-xs font-bold ${
                    isToday
                      ? "bg-primary text-on-primary shadow-xs"
                      : "bg-card text-ink border border-line"
                  }`}
                >
                  {dateNum}
                </div>
                <div className="flex flex-col">
                  <span
                    className={`text-xs font-serif font-bold ${
                      isToday ? "text-primary" : "text-ink"
                    }`}
                  >
                    {weekdayName}
                  </span>
                  {isToday && (
                    <span className="text-[10px] text-primary font-medium -mt-0.5">
                      今天
                    </span>
                  )}
                </div>
              </div>

              {/* 当天面试场次角标 */}
              {dayEvents.length > 0 ? (
                <span className="rounded-full bg-accent/15 px-1.5 py-0.2 font-mono text-[10px] font-bold text-accent border border-accent/20">
                  {dayEvents.length}场
                </span>
              ) : (
                <span className="text-[10px] text-faint">无安排</span>
              )}
            </div>

            {/* 面试卡片列表 */}
            <div className="flex-1 space-y-2">
              {dayEvents.map((evt) => (
                <CalendarInterviewCard
                  key={`${evt.application_id}-${evt.id}`}
                  event={evt}
                  currentTime={currentTime}
                  onEditRound={onEditRound}
                  onQuickStatusChange={onQuickStatusChange}
                />
              ))}

              {/* 空日程占位与快捷添加 */}
              {dayEvents.length === 0 && (
                <div className="flex h-36 flex-col items-center justify-center rounded-xl border border-dashed border-line/70 text-xs text-faint p-2 text-center">
                  <span>暂无面试排期</span>
                  {onQuickAddSchedule && (
                    <button
                      type="button"
                      onClick={() => onQuickAddSchedule(day)}
                      className="mt-1 text-primary hover:underline text-[11px]"
                    >
                      + 记排期
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
