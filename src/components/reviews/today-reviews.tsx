"use client";

import Link from "next/link";
import { btnGhost, btnPrimary } from "@/lib/ui";
import { useReviewList } from "./use-review-list";

export function TodayReviews() {
  const { data, loading, error, reload } = useReviewList({ scope: "due", source: "all", limit: 3 });
  return (
    <section aria-labelledby="today-review-heading" className="rounded-xl border border-primary/30 bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="today-review-heading" className="font-serif text-xl font-bold text-ink">今日待复习</h2>
          <p className="mt-1 text-sm text-muted">先凭记忆作答，再对照参考，让收藏真正变成掌握。</p>
        </div>
        <Link href="/reviews" className={btnGhost}>复习工作台 →</Link>
      </div>
      {error ? <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-danger"><span>{error}</span><button type="button" className={btnGhost} onClick={reload}>重试</button></div>
        : !data ? <p role="status" className="mt-4 text-sm text-muted">正在读取今日复习…</p>
        : <>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 text-sm text-muted">
            <time dateTime={data.summary.date} className="font-mono text-xs">{data.summary.date}</time>
            <span className="font-medium text-ink">{`待复习 ${data.summary.due} 题`}</span>
            <span>{`错题 ${data.summary.notebook}`}</span><span>{`追练 ${data.summary.remedial}`}</span>
            {data.summary.overdue > 0 && <span className="text-danger">{`逾期 ${data.summary.overdue}`}</span>}
            <span>{`今日已复习 ${data.summary.completed_today} 题`}</span>
          </div>
          {data.summary.due > 0 ? <>
            <ul className="mt-3 divide-y divide-line">{data.items.map(card => <li key={card.id}><Link href={`/reviews?card=${card.id}`} className="group flex items-center justify-between gap-3 py-3 text-sm focus-visible:outline-2 focus-visible:outline-primary"><span className="min-w-0 break-words text-ink group-hover:text-primary">{card.question}</span><span className="shrink-0 text-xs text-muted">{card.source === "notebook" ? "错题" : "追练"} →</span></Link></li>)}</ul>
            <Link href="/reviews" className={`${btnPrimary} mt-3`}>开始今日复习</Link>
          </> : <p className="mt-4 text-sm text-primary">{data.summary.total === 0 ? "收藏错题或完成追练后，这里会自动安排复习。" : "今日复习已完成，下次到期会在这里提醒。"}</p>}
          {loading && <p role="status" className="mt-2 text-xs text-muted">正在更新复习进度…</p>}
        </>}
    </section>
  );
}
