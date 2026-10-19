"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type Application } from "@/lib/applications-types";

interface InterviewScheduleBannerProps {
  upcomingInterviews: Application[];
  onQuickView?: (app: Application) => void;
}

export function InterviewScheduleBanner({
  upcomingInterviews,
}: InterviewScheduleBannerProps) {
  const [currentTime, setCurrentTime] = useState<number>(0);

  useEffect(() => {
    const timer = setTimeout(() => setCurrentTime(Date.now()), 0);
    return () => clearTimeout(timer);
  }, []);

  if (!upcomingInterviews || upcomingInterviews.length === 0) {
    return null;
  }

  const effectiveTimestamp = currentTime || 0;

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-3.5 sm:p-4 text-ink">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-on-primary text-xs font-bold">
            🔔
          </span>
          <span className="font-serif text-sm font-bold text-ink">
            未来 7 天待办面试日程 ({upcomingInterviews.length} 场)
          </span>
        </div>
        <span className="text-xs text-muted">及时梳理项目材料与全真模考演练</span>
      </div>

      <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {upcomingInterviews.map((app) => {
          const date = new Date(app.next_interview_at);
          const diffMs = effectiveTimestamp ? date.getTime() - effectiveTimestamp : 0;
          const diffHours = Math.round(diffMs / (1000 * 60 * 60));
          const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

          const dateFormatted = `${date.getMonth() + 1}月${date.getDate()}日 ${String(
            date.getHours()
          ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

          const isUrgent = diffHours <= 24;

          return (
            <div
              key={app.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-accent/25 bg-card p-2.5 shadow-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-serif text-sm font-bold text-ink truncate">
                    {app.company}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.2 text-[10px] font-bold ${
                      isUrgent
                        ? "bg-danger text-on-danger"
                        : "bg-accent/20 text-accent"
                    }`}
                  >
                    {isUrgent ? `仅剩 ${diffHours}h` : `${diffDays}天后`}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted mt-0.5">
                  <span className="truncate">{app.role}</span>
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
    </div>
  );
}
