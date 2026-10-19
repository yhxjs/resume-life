"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTaskReferenceTime } from "@/hooks/use-task-reference-time";
import {
  extractCalendarEvents,
  formatWeekTitle,
  getTaskUrgency,
  getWeekDays,
  groupEventsByDay,
} from "@/lib/application-calendar";
import {
  type Application,
  type CalendarDisplayMode,
  type CalendarInterviewEvent,
  type InterviewRoundStatus,
} from "@/lib/applications-types";
import { buildIcsCalendar, downloadIcsFile } from "@/lib/ics-calendar";
import { WeekCalendarGrid } from "./week-calendar-grid";
import { AgendaListView } from "./agenda-list-view";
import { inputCls } from "@/lib/ui";

interface ApplicationCalendarViewProps {
  applications: Application[];
  onEditRound?: (event: CalendarInterviewEvent) => void;
  onQuickStatusChange?: (
    applicationId: number,
    roundId: number,
    status: InterviewRoundStatus
  ) => void;
  onQuickAddSchedule?: (date: Date) => void;
}

export function ApplicationCalendarView({
  applications,
  onEditRound,
  onQuickStatusChange,
  onQuickAddSchedule,
}: ApplicationCalendarViewProps) {
  const taskReferenceTime = useTaskReferenceTime();
  const [referenceDate, setReferenceDate] = useState<Date>(() => new Date());
  const [displayMode, setDisplayMode] = useState<CalendarDisplayMode>("week");

  const [includeTasksInExport, setIncludeTasksInExport] = useState(true);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const allEvents = useMemo(() => {
    return extractCalendarEvents(applications);
  }, [applications]);

  // 聚合所有待办任务，供侧边/顶部清单展示
  const allPendingTasks = useMemo(() => {
    const list: { appId: number; company: string; role: string; task: import("@/lib/application-preparation-types").PreparationTask }[] = [];
    for (const app of applications) {
      if (!app.preparation_tasks) continue;
      for (const t of app.preparation_tasks) {
        if (!t.done) {
          list.push({ appId: app.id, company: app.company, role: app.role, task: t });
        }
      }
    }
    // 优先按截止时间升序，逾期与即将到期的在前
    return list.sort((a, b) => {
      const aDue = a.task.due_time || "9999";
      const bDue = b.task.due_time || "9999";
      return aDue.localeCompare(bDue);
    });
  }, [applications]);

  // 导出周日程
  function handleExportWeekIcs() {
    const weekEvents: CalendarInterviewEvent[] = [];
    for (const evts of eventsByDay.values()) {
      weekEvents.push(...evts);
    }
    exportCalendarIcs(`本周面试日程_${weekTitle}`, weekEvents);
    setShowExportMenu(false);
  }

  // 导出全部日程
  function handleExportAllIcs() {
    exportCalendarIcs("全部求职面试日程", allEvents);
    setShowExportMenu(false);
  }

  function exportCalendarIcs(calendarName: string, targetEvents: CalendarInterviewEvent[]) {
    const icsEvents = targetEvents.map((evt) => {
      const start = new Date(evt.interview_time);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      return {
        uid: `interview-round-${evt.id > 0 ? evt.id : `app-${evt.application_id}`}`,
        title: `【面试】${evt.company} - ${evt.role} (${evt.round_name})`,
        description: [
          `公司: ${evt.company}`,
          `岗位: ${evt.role}`,
          `轮次: ${evt.round_name}`,
          evt.interviewer ? `考官: ${evt.interviewer}` : "",
          evt.location ? `地点/平台: ${evt.location}` : "",
          evt.meeting_url ? `会议链接: ${evt.meeting_url}` : "",
          evt.notes ? `备战笔记: ${evt.notes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        location: evt.location,
        url: evt.meeting_url,
        startTime: start,
        endTime: end,
        reminderMinutes: evt.reminder_minutes ?? 15,
      };
    });

    const icsTodos = includeTasksInExport
      ? allPendingTasks
          .filter((item) => Boolean(item.task.due_time))
          .map((item) => ({
            uid: `task-prep-${item.task.id}`,
            title: `[${item.company}] ${item.task.title}`,
            description: `投递准备待办：${item.company} · ${item.role}`,
            dueTime: new Date(item.task.due_time!),
          }))
      : [];

    const content = buildIcsCalendar({
      calendarName,
      events: icsEvents,
      todos: icsTodos,
    });

    const safeName = calendarName.replace(/[\\/:*?"<>|]/g, "_");
    downloadIcsFile(`${safeName}.ics`, content);
  }

  const weekDays = useMemo(() => {
    return getWeekDays(referenceDate);
  }, [referenceDate]);

  const eventsByDay = groupEventsByDay(allEvents, weekDays);

  // 本周面试总场次
  const weekInterviewCount = [...eventsByDay.values()].reduce(
    (count, events) => count + events.length,
    0,
  );

  // 周导航操作
  function handlePrevWeek() {
    setReferenceDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() - 7);
      return next;
    });
  }

  function handleNextWeek() {
    setReferenceDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + 7);
      return next;
    });
  }

  function handleToday() {
    setReferenceDate(new Date());
  }

  function handleDateJump(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    if (!val) return;
    const [y, m, d] = val.split("-").map(Number);
    if (y && m && d) {
      setReferenceDate(new Date(y, m - 1, d));
    }
  }

  const weekTitle = formatWeekTitle(referenceDate);

  return (
    <div className="space-y-4">
      {/* 日历导航工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-card p-3.5 sm:p-4 shadow-card-subtle">
        {/* 左侧：周切换导航 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-line bg-surface p-0.5 shadow-xs">
            <button
              type="button"
              onClick={handlePrevWeek}
              className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink hover:bg-card transition-colors"
              title="查看上一周"
            >
              ← 上周
            </button>
            <button
              type="button"
              onClick={handleToday}
              className="rounded-md px-2.5 py-1 text-xs font-semibold text-primary hover:bg-card transition-colors"
              title="回到本周"
            >
              本周
            </button>
            <button
              type="button"
              onClick={handleNextWeek}
              className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink hover:bg-card transition-colors"
              title="查看下一周"
            >
              下周 →
            </button>
          </div>

          <div className="flex items-center gap-2">
            <h2 className="font-serif text-base sm:text-lg font-bold text-ink">
              {weekTitle}
            </h2>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 font-mono text-xs font-bold text-accent border border-accent/20">
              本周 {weekInterviewCount} 场面试
            </span>
          </div>
        </div>

        {/* 右侧：导出日历、日期跳转选择与周历/议程切换 */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* 外部日历导出操作下拉 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowExportMenu((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-ink hover:border-line-strong hover:bg-card shadow-xs transition-colors"
              title="导出 ICS 日历文件同步至外部日历应用"
            >
              <span>📅 导出日历</span>
              <span className="text-[10px] text-muted">▾</span>
            </button>

            {showExportMenu && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setShowExportMenu(false)}
                />
                <div className="absolute right-0 top-full z-40 mt-1.5 w-60 rounded-xl border border-line bg-card p-2 shadow-lg text-xs space-y-1">
                  <div className="px-2 py-1 font-bold text-ink border-b border-line/60">
                    同步至系统/外部日历 (.ics)
                  </div>
                  <button
                    type="button"
                    onClick={handleExportWeekIcs}
                    className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-surface text-ink transition-colors"
                  >
                    导出本周日程 ({weekInterviewCount} 场)
                  </button>
                  <button
                    type="button"
                    onClick={handleExportAllIcs}
                    className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-surface text-ink transition-colors"
                  >
                    导出全部日程 ({allEvents.length} 场)
                  </button>
                  <div className="pt-1.5 border-t border-line/60 px-2 py-1">
                    <label className="flex items-center gap-2 text-muted cursor-pointer hover:text-ink">
                      <input
                        type="checkbox"
                        checked={includeTasksInExport}
                        onChange={(e) => setIncludeTasksInExport(e.target.checked)}
                        className="rounded border-line text-primary focus:ring-primary"
                      />
                      <span>同时带入有截止时间的待办</span>
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 日期选择器快速跳转 */}
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="text-faint">跳至:</span>
            <input
              type="date"
              onChange={handleDateJump}
              className={`${inputCls} py-1 px-2 text-xs bg-surface`}
              title="选择日期跳转到对应周"
            />
          </div>

          {/* 周历 vs 议程模式切换 */}
          <div className="flex items-center rounded-lg border border-line bg-surface p-0.5 shadow-xs text-xs">
            <button
              type="button"
              onClick={() => setDisplayMode("week")}
              className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                displayMode === "week"
                  ? "bg-card text-ink font-bold shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              📅 周日历
            </button>
            <button
              type="button"
              onClick={() => setDisplayMode("agenda")}
              className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                displayMode === "agenda"
                  ? "bg-card text-ink font-bold shadow-xs border border-line"
                  : "text-muted hover:text-ink"
              }`}
            >
              📋 议程清单
            </button>
          </div>
        </div>
      </div>

      {/* 紧迫待办顶部通知条 (若存在逾期或即将截止的准备待办) */}
      {allPendingTasks.some((t) => Boolean(t.task.due_time)) && (
        <div className="rounded-xl border border-line bg-card p-3 shadow-card-subtle text-xs">
          <div className="flex items-center justify-between pb-1.5 border-b border-line/50 mb-2">
            <span className="font-semibold text-ink flex items-center gap-1.5">
              <span>⏰ 临近面试准备待办</span>
              <span className="rounded-full bg-surface px-1.5 py-0.2 text-[10px] text-muted border border-line">
                {allPendingTasks.filter((t) => Boolean(t.task.due_time)).length} 项待完成
              </span>
            </span>
            <span className="text-[11px] text-muted">防止临考遗漏</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {allPendingTasks
              .filter((t) => Boolean(t.task.due_time))
              .slice(0, 5)
              .map(({ appId, company, task }) => {
                const urgency = getTaskUrgency(task.due_time, taskReferenceTime);
                return (
                  <Link
                    key={task.id}
                    href={`/applications/${appId}/prepare`}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 transition-colors hover:shadow-xs ${
                      urgency.isOverdue
                        ? "border-danger/40 bg-danger-wash text-danger"
                        : urgency.isDueToday
                        ? "border-accent/30 bg-accent/10 text-accent font-medium"
                        : "border-line bg-surface text-ink hover:border-line-strong"
                    }`}
                  >
                    <span className="font-semibold">{company}:</span>
                    <span className="truncate max-w-[140px]">{task.title}</span>
                    <span className="font-mono text-[10px] opacity-80">({urgency.label})</span>
                  </Link>
                );
              })}
          </div>
        </div>
      )}

      {/* 视图内容切换展示 */}
      {displayMode === "week" ? (
        <WeekCalendarGrid
          weekDays={weekDays}
          currentTime={taskReferenceTime}
          eventsByDay={eventsByDay}
          onEditRound={onEditRound}
          onQuickStatusChange={onQuickStatusChange}
          onQuickAddSchedule={onQuickAddSchedule}
        />
      ) : (
        <AgendaListView
          events={allEvents}
          currentTime={taskReferenceTime}
          onEditRound={onEditRound}
          onQuickStatusChange={onQuickStatusChange}
        />
      )}
    </div>
  );
}
