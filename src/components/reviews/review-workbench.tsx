"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { btnGhost, btnPrimary, inputCls } from "@/lib/ui";
import { REVIEW_MASTERY_LABELS, type ReviewSource } from "@/lib/spaced-repetition-card-types";
import { useReviewList } from "./use-review-list";
import { ReviewSession } from "./review-session";

export function ReviewWorkbench({ initialCardId }: { initialCardId: number | null }) {
  const router = useRouter();
  const [scope, setScope] = useState<"due" | "all">("due");
  const [source, setSource] = useState<"all" | ReviewSource>("all");
  const [selected, setSelected] = useState(initialCardId);
  const { data, loading, loadingMore, error, reload, loadMore } = useReviewList({ scope, source });
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2 border-b border-line pb-5">
        <Link href="/" className="text-sm text-muted hover:text-primary">← 返回首页</Link>
        <h1 className="font-serif text-3xl font-bold text-ink">复习工作台</h1>
        <p className="max-w-prose text-sm leading-relaxed text-muted">遵循遗忘规律，用 SM-2 间隔重复安排错题与追练。先回忆、再对照、再自评，每一次回答都会留下记录。</p>
      </header>
      {selected !== null ? <ReviewSession key={selected} cardId={selected} onSaved={reload} onClose={() => { setSelected(null); router.replace("/reviews", { scroll: false }); reload(); }} /> : <>
        {data && <p className="text-sm text-muted"><time className="font-mono">{data.summary.date}</time>{` · 今日待复习 ${data.summary.due} 题 · 逾期 ${data.summary.overdue} 题 · 今日已复习 ${data.summary.completed_today} 题`}</p>}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div role="group" aria-label="复习范围" className="flex gap-2">
            <button type="button" className={scope === "due" ? btnPrimary : btnGhost} aria-pressed={scope === "due"} onClick={() => setScope("due")}>今日到期</button>
            <button type="button" className={scope === "all" ? btnPrimary : btnGhost} aria-pressed={scope === "all"} onClick={() => setScope("all")}>全部题目</button>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted">复习来源<select className={inputCls} value={source} onChange={event => setSource(event.target.value as "all" | ReviewSource)}><option value="all">全部来源</option><option value="notebook">错题本</option><option value="remedial">面试追练</option></select></label>
        </div>
        {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-danger-wash p-4 text-sm text-danger"><span>{error}</span><button type="button" className={btnGhost} onClick={reload}>重试加载</button></div>}
        {loading && <p role="status" className="text-sm text-muted">正在加载复习题目…</p>}
        {data && <ul aria-busy={loading} className="divide-y divide-line rounded-xl border border-line bg-card px-4 sm:px-6">{data.items.map(card => <li key={card.id} className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-2"><div className="flex flex-wrap gap-2 text-xs text-muted"><span>{card.source === "notebook" ? "错题本" : "面试追练"}</span><span>{card.source_label}</span></div>
            <h2 className="break-words font-serif text-base font-bold text-ink">{card.question}</h2>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted"><span className="text-primary">{REVIEW_MASTERY_LABELS[card.mastery]}</span><span>{card.mastery === "new" ? "今日可复习" : `下次复习 ${card.next_review_date}`}</span><span>{`已复习 ${card.review_count} 次`}</span>{card.mastery !== "new" && card.next_review_date < data.summary.date && <span className="text-danger">已逾期</span>}</p>
          </div>
          <Link href={`/reviews?card=${card.id}`} className={`${btnGhost} self-start sm:self-auto`}>遮住答案重答 →</Link>
        </li>)}</ul>}
        {data && data.items.length === 0 && !loading && !error && <div className="space-y-3 py-8 text-center text-sm text-muted"><p>{scope === "due" ? "当前筛选下没有待复习题目。" : "当前筛选下还没有复习题目。"}</p><Link href="/notebook" className={btnGhost}>前往错题本</Link></div>}
        {data?.nextCursor && <button type="button" className={btnGhost} disabled={loadingMore || loading} onClick={loadMore}>{loadingMore ? "正在加载…" : error ? "重试加载更多" : "加载更多"}</button>}
        <p className="max-w-prose text-xs leading-relaxed text-muted">新错题与已作答追练自动加入。遗忘后缩短间隔，连续回忆成功后逐步延长；掌握状态仅代表复习进度，已掌握题目仍会按期出现。</p>
      </>}
    </div>
  );
}
