"use client";

import Link from "next/link";
import type { InterviewItem, SeriesItem } from "@/hooks/use-interviews-page";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";
import { interviewStyleOf } from "@/lib/interview";
import { btnDanger, btnPrimary, inputCls } from "@/lib/ui";
import { LoadError } from "@/components/common/ui-bits";

type ListRow =
  | { kind: "single"; ts: string; it: InterviewItem }
  | { kind: "series"; ts: string; it: SeriesItem };

export function InterviewHistory({
  items,
  seriesItems,
  loadError,
  onRetry,
  itemsHasMore,
  itemsLoadingMore,
  itemsLoadFailed,
  onLoadMoreItems,
  seriesHasMore,
  seriesLoadingMore,
  seriesLoadFailed,
  onLoadMoreSeries,
  keyword,
  onKeywordChange,
  onRemove,
  onRemoveSeries,
}: {
  items: InterviewItem[] | null;
  seriesItems: SeriesItem[] | null;
  loadError: string;
  onRetry?: () => void;
  itemsHasMore: boolean;
  itemsLoadingMore: boolean;
  itemsLoadFailed: boolean;
  onLoadMoreItems: () => void;
  seriesHasMore: boolean;
  seriesLoadingMore: boolean;
  seriesLoadFailed: boolean;
  onLoadMoreSeries: () => void;
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  onRemove: (id: number) => void;
  onRemoveSeries: (id: number) => void;
}) {
  const rows: ListRow[] = [
    ...(items ?? []).map((item): ListRow => ({ kind: "single", ts: item.created_at, it: item })),
    ...(seriesItems ?? []).map((item): ListRow => ({ kind: "series", ts: item.created_at, it: item })),
  ].sort((left, right) => right.ts.localeCompare(left.ts));
  const recordsLoaded = items !== null && seriesItems !== null;

  return (
    <>
      {loadError && <LoadError message={loadError} onRetry={onRetry} />}

      {/* 加载中：骨架占位，避免首屏慢时误以为功能缺失 */}
      {!recordsLoaded && !loadError && (
        <div className="mt-10 space-y-4" role="status" aria-live="polite">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <h2 className="font-serif text-base font-bold text-ink">历史实战与模考复盘</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div aria-hidden className="h-24 animate-pulse rounded-xl bg-surface" />
            <div aria-hidden className="h-24 animate-pulse rounded-xl bg-surface" />
          </div>
        </div>
      )}

      {/* 空态：首次使用时给出引导，而不是整块沉默 */}
      {recordsLoaded && !loadError && rows.length === 0 && keyword.trim() === "" && (
        <div className="mt-10 rounded-xl border border-dashed border-line bg-card p-8 text-center text-sm text-muted">
          还没有面试记录：完成一场模拟面试或进阶面试后，这里会沉淀历史实战与复盘数据。
        </div>
      )}

      {/* 历史实战记录区（卡片网格化） */}
      {(items !== null || seriesItems !== null) && (rows.length > 0 || keyword.trim() !== "") && (
        <div className="mt-10 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
              <h2 className="font-serif text-base font-bold text-ink">历史实战与模考复盘</h2>
            </div>
            <div className="w-72">
              <input
                type="search"
                aria-label="搜索面试记录"
                placeholder="搜索 JD、题目或作答关键词…"
                className={inputCls}
                value={keyword}
                onChange={(event) => onKeywordChange(event.target.value)}
              />
            </div>
          </div>

          {rows.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {rows.map((row) => row.kind === "single" ? (
                <div
                  key={`i-${row.it.id}`}
                  className="group flex flex-col justify-between rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all duration-150 hover:border-primary/40 hover:bg-surface/30"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          href={`/interviews/${row.it.id}`}
                          className="font-serif text-base font-bold text-ink hover:text-primary transition-colors line-clamp-1"
                        >
                          {row.it.resume_title}
                          {" "}<ResumeVersionBadge {...row.it} />
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                            {interviewStyleOf(row.it.style).label}
                          </span>
                          <span className="rounded border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
                            {row.it.answered}/{row.it.rounds} 题
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                              row.it.status === "finished"
                                ? "bg-surface text-muted"
                                : "bg-accent-wash text-accent font-bold"
                            }`}
                          >
                            {row.it.status === "finished" ? "已完成" : "进行中"}
                          </span>
                        </div>
                      </div>
                    </div>

                    <p className="text-xs text-muted line-clamp-2 leading-relaxed">
                      {row.it.jd || "无职位描述记录"}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-xs">
                    <span className="font-mono text-[11px] text-faint">
                      {new Date(row.it.created_at).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onRemove(row.it.id)}
                        className={btnDanger}
                      >
                        删除
                      </button>
                      <Link href={`/interviews/${row.it.id}`} className={btnPrimary}>
                        {row.it.status === "finished" ? "查看复盘" : "继续作答"}
                      </Link>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key={`s-${row.it.id}`}
                  className="group flex flex-col justify-between rounded-xl border border-accent/30 bg-card p-4 shadow-card-subtle transition-all duration-150 hover:border-accent/60 hover:bg-accent-wash/20"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link
                          href={`/interviews/series/${row.it.id}`}
                          className="font-serif text-base font-bold text-ink hover:text-accent transition-colors line-clamp-1"
                        >
                          {row.it.resume_title}
                          {" "}<ResumeVersionBadge {...row.it} />
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-accent-wash px-2 py-0.5 text-[10px] font-bold text-accent border border-accent/25">
                            进阶三轮连打
                          </span>
                          <span className="rounded border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
                            {row.it.rounds_done}/{row.it.rounds_total} 轮完成
                          </span>
                          {row.it.final_overall !== null && (
                            <span className="rounded bg-primary-soft px-2 py-0.5 font-mono text-[10px] font-bold text-primary">
                              综合总评 {row.it.final_overall}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <p className="text-xs text-muted line-clamp-2 leading-relaxed">
                      一面技术面 → 二面主管面 → 三面 HR 面 ｜ {row.it.jd || "无职位描述记录"}
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-xs">
                    <span className="font-mono text-[11px] text-faint">
                      {new Date(row.it.created_at).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onRemoveSeries(row.it.id)}
                        className={btnDanger}
                      >
                        删除
                      </button>
                      <Link href={`/interviews/series/${row.it.id}`} className={btnPrimary}>
                        {row.it.status === "finished" ? "跨轮总评" : "继续晋级"}
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-faint">没有匹配的面试记录，换个关键词试试。</p>
          )}
          {(itemsHasMore || seriesHasMore) && (
            <div className="flex flex-wrap justify-center gap-3">
              {itemsHasMore && (
                <button type="button" className={btnPrimary} onClick={onLoadMoreItems} disabled={itemsLoadingMore}>
                  {itemsLoadingMore ? "加载中…" : itemsLoadFailed ? "重试加载单轮面试" : "加载更多单轮面试"}
                </button>
              )}
              {seriesHasMore && (
                <button type="button" className={btnPrimary} onClick={onLoadMoreSeries} disabled={seriesLoadingMore}>
                  {seriesLoadingMore ? "加载中…" : seriesLoadFailed ? "重试加载进阶面试" : "加载更多进阶面试"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {!recordsLoaded && !loadError && (
        <div className="mt-10" role="status" aria-label="面试记录加载中">
          <div className="skeleton h-6 w-32 rounded-md" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            <div className="skeleton h-32 w-full rounded-xl" />
            <div className="skeleton h-32 w-full rounded-xl" />
          </div>
        </div>
      )}
    </>
  );
}
