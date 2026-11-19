"use client";

import Link from "next/link";
import { type Application } from "@/lib/applications-types";
import type { UpcomingApplication } from "@/lib/application-stats";
import { getInterviewUrgency } from "@/lib/application-calendar";

interface InterviewScheduleBannerProps {
  upcomingInterviews: UpcomingApplication[];
  currentTime: number;
  onQuickView?: (app: Application) => void;
}

export function InterviewScheduleBanner({
  upcomingInterviews,
  currentTime,
}: InterviewScheduleBannerProps) {
  if (!upcomingInterviews || upcomingInterviews.length === 0) {
    return null;
  }

  return (
    <div role="region" aria-label={`面试排期提醒（${upcomingInterviews.length} 条投递）`} className="rounded-xl border border-accent/30 bg-accent/5 p-3.5 sm:p-4 text-ink">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-on-primary text-xs font-bold">
            🔔
          </span>
          <span className="font-serif text-sm font-bold text-ink">
            面试排期提醒（{upcomingInterviews.length} 条投递）
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>每条投递仅显示最近一次排期</span>
          <Link href="/applications?view=calendar" className="text-primary underline-offset-2 hover:underline">
            查看完整日程
          </Link>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {upcomingInterviews.slice(0, 3).map((app) => {
          const date = new Date(app.next_interview_at);
          const urgency = getInterviewUrgency(app.next_interview_at, currentTime);
          const diffMs = date.getTime() - currentTime;

          const dateFormatted = `${date.getMonth() + 1}月${date.getDate()}日 ${String(
            date.getHours()
          ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

          const label = urgency.isPast ? "已到排期时间"
            : diffMs <= 60 * 60_000 ? `仅剩 ${Math.max(1, Math.ceil(diffMs / 60_000))}m`
              : diffMs <= 24 * 60 * 60_000 ? `仅剩 ${Math.ceil(diffMs / 3_600_000)}h`
                : `${Math.ceil(diffMs / 86_400_000)}天后`;

          return (
            <div
              key={app.id}
              className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-accent/25 bg-card p-2.5 shadow-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere] font-serif text-sm font-bold leading-snug text-ink">
                    {app.company}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.2 text-[10px] font-bold ${
                      diffMs >= 0 && diffMs <= 24 * 60 * 60_000
                        ? "bg-danger text-on-danger"
                        : "bg-accent/20 text-accent"
                    }`}
                  >
                    {label}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted mt-0.5">
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">{app.role}</span>
                  <span>·</span>
                  <span className="font-mono text-faint shrink-0">{dateFormatted}</span>
                </div>
              </div>

              {/* 快捷发起针对性模考 */}
              {app.jd ? (
                <Link
                  href={`/interviews?applicationId=${app.id}`}
                  title="以此 JD 发起针对性文字模考"
                  className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/25 transition-colors"
                >
                  去模考
                </Link>
              ) : (
                <Link
                  href="/interviews"
                  className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink transition-colors"
                >
                  模考
                </Link>
              )}
            </div>
          );
        })}
      </div>
      {upcomingInterviews.length > 3 && <p className="mt-2 text-xs text-muted">
        另有 {upcomingInterviews.length - 3} 条投递排期，请查看完整日程。
      </p>}
    </div>
  );
}
