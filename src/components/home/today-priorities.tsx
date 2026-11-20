"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useDebouncedSearch } from "@/hooks/use-debounced-search";
import { jsonFetch } from "@/lib/fetcher";
import { readHomePriorities, type HomePriorities } from "@/lib/home-priorities-contract";
import { btnGhost } from "@/lib/ui";
import { HomeIcon } from "./home-icon";
import styles from "./home.module.css";

const KIND_LABELS = { interview: "面试准备", materials: "补齐资料", review: "复习任务" };

export function TodayPriorities() {
  const [data, setData] = useState<HomePriorities | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(value => value + 1), []);

  useDebouncedSearch({
    queryKey: `home-priorities:${version}`, delay: 0,
    load: async signal => {
      const params = new URLSearchParams({ time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      return readHomePriorities(await jsonFetch<unknown>(`/api/home/priorities?${params}`, { signal, cache: "no-store" }));
    },
    onStart: () => { setLoading(true); setError(""); },
    onSuccess: value => { setData(value); setLoading(false); },
    onError: () => { setData(null); setError("今日重点暂时无法读取，请重试。"); setLoading(false); },
  });

  useEffect(() => {
    const refreshVisible = () => { if (document.visibilityState === "visible") reload(); };
    const timer = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("reviews-updated", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("reviews-updated", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [reload]);

  return (
    <section aria-labelledby="today-priorities-heading" className={`${styles.focusPanel} relative overflow-hidden rounded-[1.5rem] border border-line p-5 shadow-card-subtle sm:p-8 lg:p-9`}>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-2.5 font-semibold tracking-[0.16em] text-primary"><span aria-hidden className="flex h-5 w-5 items-center justify-center rounded-full border border-primary/25"><span className="h-1.5 w-1.5 rounded-full bg-primary" /></span>今日焦点</span>
        {data && <time dateTime={data.date} className="inline-flex items-center gap-2 rounded-full border border-line bg-card/70 px-3 py-1.5 font-mono text-[11px] text-muted"><HomeIcon kind="calendar" className="h-3.5 w-3.5" />{data.date}</time>}
      </div>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4 sm:mt-6">
        <div className="max-w-2xl">
          <h1 id="today-priorities-heading" className="font-serif text-[27px] font-bold leading-snug tracking-tight text-ink sm:text-4xl lg:text-[42px]">今天最重要的三件事</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">根据最近面试、缺失资料和复习任务，为你排好今天的行动顺序。</p>
        </div>
        {data && data.items.length > 0 && <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-primary-soft px-3 py-1.5 text-xs font-medium text-primary"><span aria-hidden className="flex gap-0.5">{data.items.map(item => <span key={item.id} className="h-2.5 w-1 rounded-full bg-primary/70" />)}</span>优先处理 {data.items.length} 项</span>}
      </div>

      {error ? (
        <div role="alert" className="mt-7 flex flex-wrap items-center gap-3 rounded-2xl border border-danger/20 bg-danger-wash p-5 text-sm text-danger">
          <span>{error}</span><button type="button" className={btnGhost} onClick={reload}>重试读取今日重点</button>
        </div>
      ) : !data ? (
        <div className="mt-7" role="status">
          <p className="text-sm text-muted">正在整理今天的重点…</p>
          <div aria-hidden className="mt-4 grid gap-4 lg:grid-cols-3">{[1, 2, 3].map(rank => <div key={rank} className="flex h-72 flex-col rounded-2xl border border-line bg-surface/60 p-6 motion-safe:animate-pulse"><div className="h-10 w-10 rounded-xl bg-surface-2" /><div className="mt-6 h-5 w-3/4 rounded bg-surface-2" /><div className="mt-4 h-3 w-full rounded bg-surface-2" /><div className="mt-2 h-3 w-2/3 rounded bg-surface-2" /><div className="mt-auto h-10 rounded-xl bg-surface-2" /></div>)}</div>
        </div>
      ) : data.items.length === 0 ? (
        <div className="mt-7 flex flex-col items-start gap-5 rounded-2xl border border-dashed border-primary/30 bg-primary-soft/25 p-5 sm:flex-row sm:p-7">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary"><HomeIcon kind="check" className="h-6 w-6" /></span>
          <div>
            <p className="font-serif text-xl font-bold text-ink">今天暂时没有需要优先处理的事项</p>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">未来 7 天没有待面试，推进中的岗位资料齐全，也没有到期复习。可以继续寻找机会，或回顾已有积累。</p>
            <div className="mt-5 flex flex-wrap gap-3"><Link href="/applications" className={btnGhost}>管理投递 →</Link><Link href="/reviews" className={btnGhost}>查看复习计划 →</Link></div>
          </div>
        </div>
      ) : (
        <ol aria-label="今日重点排序" className={`mt-7 grid gap-4 sm:mt-8 sm:gap-5 ${data.items.length === 1 ? "max-w-2xl" : data.items.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3"}`}>
          {data.items.map((item, index) => (
            <li key={item.id} className={`${styles.card} flex min-w-0 flex-col overflow-hidden rounded-2xl border p-5 sm:p-6 ${index === 0 ? `${styles.leadCard} border-chrome-line text-chrome-ink` : "border-line bg-card text-ink"}`}>
              <div className="flex items-center justify-between gap-3">
                <span className={`inline-flex items-center gap-3 text-xs font-medium ${index === 0 ? "text-chrome-muted" : "text-muted"}`}>
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${index === 0 ? "border-chrome-line bg-chrome-line/40 text-chrome-active" : item.kind === "review" ? "border-accent/15 bg-accent-wash text-accent" : "border-primary/15 bg-primary-soft/60 text-primary"}`}><HomeIcon kind={item.kind} /></span>
                  {KIND_LABELS[item.kind]}
                </span>
                <span aria-hidden className={`font-mono text-[38px] font-medium leading-none tracking-[-0.07em] ${index === 0 ? "text-chrome-muted/50" : "text-line-strong"}`}>{String(index + 1).padStart(2, "0")}</span>
              </div>
              <h2 className="mt-5 font-serif text-xl font-bold leading-snug [overflow-wrap:anywhere]">{item.title}</h2>
              <div className="mt-3">
                <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${index === 0 ? "bg-chrome-line/70 text-chrome-active" : item.urgent ? "bg-accent-wash text-accent" : "bg-surface text-muted"}`}><span aria-hidden className="h-1 w-1 rounded-full bg-current" />{item.badge}</span>
              </div>
              <p className={`mt-3 flex-1 text-sm leading-relaxed [overflow-wrap:anywhere] ${index === 0 ? "text-chrome-muted" : "text-muted"}`}>{item.reason}</p>
              <Link href={item.href} aria-label={`${item.action}：${item.title}`} className={`group mt-6 flex min-h-11 items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 ${index === 0 ? "bg-chrome-active text-on-chrome-active hover:bg-chrome-ink focus-visible:outline-chrome-active" : "bg-surface text-ink hover:bg-primary-soft hover:text-primary focus-visible:outline-primary"}`}>
                {item.action}<span aria-hidden className="text-lg leading-none transition-transform motion-safe:group-hover:translate-x-1">→</span>
              </Link>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-6 flex flex-wrap items-start justify-between gap-3 border-t border-line/70 pt-4 text-[11px] text-muted">
        <details className="max-w-prose">
          <summary className="w-fit cursor-pointer rounded hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">如何排序</summary>
          <p className="mt-2 leading-relaxed">48 小时内面试 → 逾期复习 → 7 天内面试 → 缺失简历版本或 JD → 今日复习 → 其他准备资料。同一岗位合并展示，最多三项。</p>
        </details>
        {loading && data && <span role="status">正在更新今日重点…</span>}
        {!loading && data && <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary/65" />随日程与复习进度更新</span>}
      </div>
    </section>
  );
}
