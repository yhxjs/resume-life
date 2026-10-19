"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ROUND_STATUS_CONFIG,
  type CalendarInterviewEvent,
  type InterviewRoundStatus,
} from "@/lib/applications-types";
import { getInterviewUrgency, getTaskUrgency } from "@/lib/application-calendar";
import { buildIcsCalendar, downloadIcsFile } from "@/lib/ics-calendar";
import { ApplicationVersionsDialog } from "@/components/application/application-versions-dialog";

interface CalendarInterviewCardProps {
  event: CalendarInterviewEvent;
  currentTime: number;
  onEditRound?: (event: CalendarInterviewEvent) => void;
  onQuickStatusChange?: (
    applicationId: number,
    roundId: number,
    status: InterviewRoundStatus
  ) => void;
}

export function CalendarInterviewCard({
  event,
  currentTime,
  onEditRound,
  onQuickStatusChange,
}: CalendarInterviewCardProps) {
  const [showVersions, setShowVersions] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const dateObj = new Date(event.interview_time);
  const timeFormatted = Number.isNaN(dateObj.getTime())
    ? "--:--"
    : `${String(dateObj.getHours()).padStart(2, "0")}:${String(
        dateObj.getMinutes()
      ).padStart(2, "0")}`;

  const reminderMinutes = typeof event.reminder_minutes === "number" ? event.reminder_minutes : 15;
  const urgency = currentTime
    ? getInterviewUrgency(event.interview_time, currentTime, reminderMinutes)
    : { isPast: false, isUrgent: false, isSoon: false, isAlarming: false, diffMinutes: 0, diffHours: 0, diffDays: 0, label: "" };

  const statusCfg = ROUND_STATUS_CONFIG[event.status] || {
    label: event.status,
    color: "text-muted",
    bg: "bg-surface",
    border: "border-line",
  };

  async function handleCopyMeetingUrl() {
    if (!event.meeting_url) return;
    try {
      await navigator.clipboard.writeText(event.meeting_url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // 容错处理
    }
  }

  function handleExportSingleIcs() {
    const start = new Date(event.interview_time);
    if (Number.isNaN(start.getTime())) return;
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const content = buildIcsCalendar({
      calendarName: `${event.company} · ${event.round_name}`,
      events: [
        {
          uid: `interview-round-${event.id > 0 ? event.id : `app-${event.application_id}`}`,
          title: `【面试】${event.company} - ${event.role} (${event.round_name})`,
          description: [
            `公司: ${event.company}`,
            `岗位: ${event.role}`,
            `轮次: ${event.round_name}`,
            event.interviewer ? `面试官: ${event.interviewer}` : "",
            event.location ? `地点/平台: ${event.location}` : "",
            event.meeting_url ? `会议链接: ${event.meeting_url}` : "",
            event.notes ? `备战笔记: ${event.notes}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          location: event.location,
          url: event.meeting_url,
          startTime: start,
          endTime: end,
          reminderMinutes,
        },
      ],
    });

    const filePrefix = `面试_${event.company}_${event.round_name}`.replace(/[\\/:*?"<>|]/g, "_");
    downloadIcsFile(`${filePrefix}.ics`, content);
  }

  return (
    <>
    <div
      className={`group relative flex flex-col justify-between rounded-xl border p-2.5 transition-all text-xs ${
        urgency.isAlarming && event.status === "scheduled"
          ? "border-danger bg-danger-wash/60 shadow-xs ring-2 ring-danger/40 animate-pulse"
          : urgency.isUrgent && event.status === "scheduled"
            ? "border-accent/60 bg-accent/10 shadow-xs ring-1 ring-accent/30"
            : "border-line bg-card hover:border-line-strong hover:shadow-card-subtle"
      }`}
    >
      <div>
        {/* 顶部时间与状态徽章 */}
        <div className="flex items-center justify-between gap-1.5 pb-1.5 border-b border-line/60">
          <div className="flex items-center gap-1.5">
            <span className="font-mono font-bold text-ink text-[13px]">
              {timeFormatted}
            </span>
            {/* 提前提醒闹钟指示器 */}
            {reminderMinutes > 0 && event.status === "scheduled" && (
              <span
                className="inline-flex items-center text-[10px] text-faint hover:text-muted cursor-help"
                title={`已设置提前 ${reminderMinutes >= 60 ? `${reminderMinutes / 60}小时` : `${reminderMinutes}分钟`} 提醒`}
              >
                🔔 {reminderMinutes >= 1440 ? "1d" : reminderMinutes >= 60 ? `${reminderMinutes / 60}h` : `${reminderMinutes}m`}
              </span>
            )}
            {urgency.isAlarming && event.status === "scheduled" && (
              <span className="flex items-center gap-0.5 rounded px-1 py-0.2 text-[10px] font-bold bg-danger text-on-danger shrink-0">
                🚨 {urgency.label}
              </span>
            )}
            {!urgency.isAlarming && urgency.isUrgent && event.status === "scheduled" && (
              <span className="flex items-center gap-0.5 rounded px-1 py-0.2 text-[10px] font-bold bg-danger text-on-danger shrink-0">
                ⚡ {urgency.label}
              </span>
            )}
            {!urgency.isUrgent && urgency.isSoon && event.status === "scheduled" && (
              <span className="rounded px-1 py-0.2 text-[10px] font-medium bg-accent/15 text-accent shrink-0">
                {urgency.label}
              </span>
            )}
          </div>

          <span
            className={`rounded px-1.5 py-0.2 text-[10px] font-medium border ${statusCfg.bg} ${statusCfg.color} ${statusCfg.border}`}
          >
            {statusCfg.label}
          </span>
        </div>

        {/* 公司与岗位信息 */}
        <div className="mt-2 space-y-0.5">
          <div className="flex items-baseline justify-between gap-1">
            <h4
              className="font-serif font-bold text-ink truncate text-[13px]"
              title={event.company}
            >
              {event.company}
            </h4>
            <span className="text-[10px] text-primary font-medium shrink-0">
              {event.round_name}
            </span>
          </div>
          <p className="text-muted truncate text-[11px]" title={event.role}>
            {event.role}
          </p>
        </div>

        {/* 会议地点 / 会议链接直达 */}
        {(event.location || event.meeting_url) && (
          <div className="mt-1.5 rounded-lg bg-surface/90 border border-line/50 p-1.5 text-[11px] space-y-1">
            {event.location && (
              <div className="flex items-center gap-1 text-ink truncate">
                <span className="text-primary shrink-0">📍</span>
                <span className="truncate font-medium" title={event.location}>
                  {event.location}
                </span>
              </div>
            )}
            {event.meeting_url && (
              <div className="flex items-center justify-between gap-1.5 pt-0.5 border-t border-line/40">
                <a
                  href={event.meeting_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-primary hover:underline font-semibold truncate"
                  title={`点击打开会议：${event.meeting_url}`}
                >
                  <span>进入会议</span>
                  <span aria-hidden>↗</span>
                </a>
                <button
                  type="button"
                  onClick={handleCopyMeetingUrl}
                  className="rounded px-1.5 py-0.2 text-[10px] text-muted hover:text-ink hover:bg-card border border-line/60 transition-colors shrink-0"
                  title="复制会议链接"
                >
                  {copiedUrl ? "已复制 ✓" : "复制链接"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* 面试官或备战备注 */}
        {(event.interviewer || event.notes) && (
          <div className="mt-1.5 rounded bg-surface/80 p-1.5 text-[11px] text-muted space-y-0.5">
            {event.interviewer && (
              <div className="flex items-center gap-1 truncate">
                <span className="text-faint">考官:</span>
                <span className="text-ink truncate">{event.interviewer}</span>
              </div>
            )}
            {event.notes && (
              <p className="text-faint truncate" title={event.notes}>
                {event.notes}
              </p>
            )}
          </div>
        )}
        {/* 紧迫准备待办联动展示 (如有未完成的待办) */}
        {event.preparation_tasks && event.preparation_tasks.filter((t) => !t.done).length > 0 && (
          <div className="mt-2 rounded-lg bg-surface/90 border border-line/60 p-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-ink flex items-center gap-1">
                <span>📝 紧迫准备</span>
                <span className="rounded-full bg-card px-1 text-[10px] text-muted border border-line">
                  {event.preparation_tasks.filter((t) => !t.done).length}
                </span>
              </span>
              <Link
                href={`/applications/${event.application_id}/prepare`}
                className="text-[10px] text-primary hover:underline"
              >
                待办管理 →
              </Link>
            </div>
            <ul className="space-y-1">
              {event.preparation_tasks
                .filter((t) => !t.done)
                .slice(0, 2)
                .map((task) => {
                  const taskUrgency = currentTime ? getTaskUrgency(task.due_time, currentTime) : { hasDue: false, isOverdue: false, isDueToday: false, isDueSoon: false, label: "" };
                  return (
                    <li key={task.id} className="flex items-center justify-between gap-1 text-[11px] text-muted truncate">
                      <span className="truncate" title={task.title}>• {task.title}</span>
                      {taskUrgency.hasDue && (
                        <span
                          className={`shrink-0 rounded px-1 text-[9px] font-medium border ${
                            taskUrgency.isOverdue
                              ? "bg-danger-wash text-danger border-danger/30"
                              : taskUrgency.isDueToday
                              ? "bg-accent/15 text-accent border-accent/20"
                              : "bg-surface text-faint border-line"
                          }`}
                        >
                          {taskUrgency.label}
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        )}
      </div>

      {/* 底部操作条 */}
      <Link href={`/applications/${event.application_id}/prepare`} className="mt-2 rounded-lg bg-primary-soft px-2 py-1.5 text-center text-xs font-semibold text-primary focus-visible:outline-2 focus-visible:outline-primary">投递准备 →</Link>
      <div className="mt-2.5 flex items-center justify-between pt-2 border-t border-line/40">
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setShowVersions(true)}
            className="rounded px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-primary">
            投递版
          </button>
          {/* 去模考快捷按钮 */}
          {event.jd ? (
            <Link
              href={`/interviews?applicationId=${event.application_id}`}
              className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              title="以此 JD 发起针对性全真模拟面试"
            >
              <span>模考</span>
              <span aria-hidden>→</span>
            </Link>
          ) : (
            <Link
              href="/interviews"
              className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:text-ink hover:bg-surface transition-colors"
            >
              模考
            </Link>
          )}

          {/* 快捷变更状态 (如果是待面，允许一键标记已通过) */}
          {event.status === "scheduled" && onQuickStatusChange && event.id > 0 && (
            <button
              type="button"
              onClick={() => onQuickStatusChange(event.application_id, event.id, "passed")}
              className="rounded px-1.5 py-0.5 text-[10px] text-ok hover:bg-primary-soft transition-colors"
              title="快速标记为已通过此轮"
            >
              ✓ 通过
            </button>
          )}
        </div>

        {/* 右侧：单场导出 ICS + 编辑轮次 */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleExportSingleIcs}
            className="rounded p-1 text-muted hover:text-primary hover:bg-surface transition-colors"
            title="导出此场面试到外部日历 (.ics)"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
              <path fillRule="evenodd" d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z" clipRule="evenodd" />
            </svg>
          </button>

          {onEditRound && (
            <button
              type="button"
              onClick={() => onEditRound(event)}
              className="rounded p-1 text-muted hover:text-ink hover:bg-surface transition-colors"
              title="查看或修改轮次安排"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
    {showVersions && <ApplicationVersionsDialog
      application={{ id: event.application_id, company: event.company, role: event.role }}
      onClose={() => setShowVersions(false)} />}
    </>
  );
}
