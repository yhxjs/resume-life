"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { REVIEW_MASTERY_LABELS } from "@/lib/spaced-repetition-card-types";
import { CategoryChangeDialog, CategoryManageDialog } from "@/components/notebook";
import { Empty } from "@/components/common/ui-bits";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useCompositionInput } from "@/hooks/use-composition-input";
import { useNotebookCategories } from "@/hooks/use-notebook-categories";
import { useNotebookDeletion } from "@/hooks/use-notebook-deletion";
import { DIMENSIONS } from "@/lib/scores";
import { readNotebookListPage, type NotebookCategoryFilter, type NotebookEntry } from "@/lib/notebook-records";
import { btnDanger, btnGhost, btnPrimary, inputCls, scoreTextCls } from "@/lib/ui";

function categoryChipCls(active: boolean): string {
  return `max-w-full rounded-2xl px-3.5 py-1 text-left text-xs font-medium [overflow-wrap:anywhere] transition-all ${
    active
      ? "bg-primary text-on-primary shadow-xs font-bold"
      : "border border-line bg-card text-muted hover:border-primary/40 hover:text-ink"
  }`;
}

export default function NotebookPage() {
  const { categories, error: categoriesError, reload: reloadCategories } = useNotebookCategories();
  const [filterCategory, setFilterCategory] = useState<NotebookCategoryFilter>("all");
  const [filterCategoryName, setFilterCategoryName] = useState("");
  const [filterSource, setFilterSource] = useState<"" | "drill" | "interview" | "application_interview">("");
  const [keyword, setKeyword] = useState("");
  const { bind: keywordInputBind } = useCompositionInput("", setKeyword);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [movingEntry, setMovingEntry] = useState<NotebookEntry | null>(null);
  const dialogOpen = useRef(false);

  const {
    items: storedEntries,
    nextCursor,
    loadingMore,
    listError: loadError,
    failedCursor,
    loadMore: loadEntries,
    reload: reloadList,
  } = useCursorList<NotebookEntry>({
    queryKey: JSON.stringify(["notebook", filterCategory, filterSource, keyword.trim()]),
    delay: 250,
    validatePage: (page, cursor) => { readNotebookListPage(page, { category: filterCategory, source: filterSource, keyword, cursor }); },
    buildUrl: (cursor) => {
      const params = new URLSearchParams();
      if (filterCategory !== "all") params.set("category_id", String(filterCategory));
      if (filterSource !== "") params.set("source", filterSource);
      if (keyword.trim()) params.set("q", keyword.trim());
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return `/api/notebook${qs ? `?${qs}` : ""}`;
    },
  });
  const deletion = useNotebookDeletion(() => {
    reloadList();
    reloadCategories();
    window.dispatchEvent(new Event("reviews-updated"));
  });
  const entries = storedEntries?.filter(entry => !deletion.deletedIds.has(entry.id)) ?? null;

  function afterChange() {
    reloadList();
    reloadCategories();
  }

  function openCategories(entry?: NotebookEntry) {
    if (dialogOpen.current || !deletion.canStart()) return;
    dialogOpen.current = true;
    if (entry) setMovingEntry(entry); else setManageOpen(true);
  }

  function closeCategories() {
    dialogOpen.current = false;
    setManageOpen(false); setMovingEntry(null);
  }

  function removeEntry(entry: NotebookEntry) {
    if (!dialogOpen.current) return deletion.remove(entry);
  }

  const hasFilter = filterCategory !== "all" || filterSource !== "" || keyword.trim() !== "";
  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">错题温习本</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            收藏真实面试、模拟面试与题目练习中的薄弱题目，自定义分类，保留原始作答与练习参考。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/reviews" className={btnPrimary}>今日复习</Link>
          <button
            type="button"
            className={btnGhost}
            onClick={() => openCategories()}
            disabled={deletion.busy}
          >
            管理错题分类
          </button>
        </div>
      </div>

      <ToolHistoryDeletionFeedback deletion={deletion} deletingLabel="正在移出错题…" />

      {/* 结构化分类胶囊过滤器 */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-card p-4 shadow-card-subtle">
        <span className="text-xs text-muted font-medium mr-1 font-serif">按分类速查：</span>
        <button
          type="button"
          className={categoryChipCls(filterCategory === "all")}
          aria-pressed={filterCategory === "all"}
          onClick={() => setFilterCategory("all")}
        >
          全部错题
        </button>
        <button
          type="button"
          className={categoryChipCls(filterCategory === 0)}
          aria-pressed={filterCategory === 0}
          onClick={() => setFilterCategory(0)}
        >
          未分类
        </button>
        {(categories ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            className={categoryChipCls(filterCategory === c.id)}
            aria-pressed={filterCategory === c.id}
            onClick={() => { setFilterCategory(c.id); setFilterCategoryName(c.name); }}
          >
            {c.name}
            <span className="ml-1.5 font-mono text-[10px] opacity-75">({c.entry_count})</span>
          </button>
        ))}
      </div>

      {typeof filterCategory === "number" && filterCategory > 0 && categories !== null && !categories.some(category => category.id === filterCategory) && (
        <p className="text-sm text-muted whitespace-pre-wrap [overflow-wrap:anywhere]">当前分类：{filterCategoryName || `#${filterCategory}`}（未出现在最新分类列表中，可切回全部错题或重新选择分类。）</p>
      )}

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <h2 className="font-serif text-base font-bold text-ink">错题列表{entries !== null && `（已显示 ${entries.length} 题）`}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-32">
              <select
                aria-label="按来源过滤"
                className={inputCls}
                value={filterSource}
                onChange={(e) => setFilterSource(e.target.value as "" | "drill" | "interview" | "application_interview")}
              >
                <option value="">全部来源</option>
                <option value="drill">题目练习</option>
                <option value="interview">模拟面试</option>
                <option value="application_interview">真实面试</option>
              </select>
            </div>
            <div className="w-64">
              <input
                type="search"
                aria-label="搜索错题"
                placeholder="搜索题目、回答或点评"
                className={inputCls}
                {...keywordInputBind}
              />
            </div>
          </div>
        </div>

        {entries !== null && <>
          {entries.length > 0 ? (
            <div className="space-y-4">
              {entries.map((entry) => {
                const isExpanded = expandedId === entry.id;
                return (
                  <article
                    key={entry.id}
                    aria-label={`错题 #${entry.id}`}
                    className={`rounded-2xl border bg-card p-5 shadow-card-subtle transition-all duration-150 ${
                      isExpanded ? "border-primary/40 ring-1 ring-primary/10" : "border-line hover:border-line-strong"
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`max-w-full rounded-lg px-2 py-0.5 text-[10px] font-bold [overflow-wrap:anywhere] ${
                              entry.source !== "drill"
                                ? "bg-accent-wash text-accent border border-accent/20"
                                : "bg-primary-soft text-primary border border-primary/20"
                            }`}
                          >
                            {entry.source === "drill" ? "练习" : entry.source === "interview" ? "模考" : "真实面试"} · {entry.source_label}
                          </span>
                          <span className={`max-w-full rounded-lg border border-line bg-surface px-2 py-0.5 text-[10px] text-muted [overflow-wrap:anywhere] ${entry.category_name === null ? "border-dashed text-faint" : ""}`}>
                            {entry.category_name ?? "未分类"}
                          </span>
                          <span className="text-[11px] text-faint font-mono">
                            收藏于 {new Date(entry.created_at).toLocaleDateString()}
                          </span>
                        </div>

                        <h3 className="font-serif text-base font-bold text-ink leading-relaxed">
                          <button type="button" className="w-full text-left whitespace-pre-wrap [overflow-wrap:anywhere] hover:text-primary transition-colors" aria-expanded={isExpanded} aria-controls={`notebook-review-${entry.id}`} onClick={() => setExpandedId(isExpanded ? null : entry.id)}>
                            {entry.question}
                          </button>
                        </h3>
                        {entry.review_card_id && <div className="flex flex-wrap items-center gap-3 text-xs text-muted"><span className="text-primary">{REVIEW_MASTERY_LABELS[entry.review_mastery ?? "new"]}</span><span>{entry.review_mastery === "new" ? "今日可复习" : `下次复习 ${entry.next_review_date}`}</span><Link href={`/reviews?card=${entry.review_card_id}`} className="font-medium text-primary hover:underline">遮住答案重答 →</Link></div>}
                      </div>

                      <div className="flex shrink-0 items-center justify-end gap-2 self-end sm:self-start">
                        <button className={btnGhost} disabled={deletion.busy} onClick={() => openCategories(entry)}>
                          分类
                        </button>
                        <button className={btnDanger} disabled={deletion.busy} onClick={() => removeEntry(entry)}>
                          移出
                        </button>
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          aria-controls={`notebook-review-${entry.id}`}
                          onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                          className="px-2.5 py-1.5 text-xs text-primary font-medium hover:underline flex items-center gap-1"
                        >
                          <span>{isExpanded ? "收起" : "展开温习"}</span>
                          <span aria-hidden className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`}>↓</span>
                        </button>
                      </div>
                    </div>

                    {/* 展开温习对比区：我的作答与练习参考 */}
                    {isExpanded && (
                      <div id={`notebook-review-${entry.id}`} role="region" aria-label={`错题 #${entry.id} 温习内容`} className="mt-5 space-y-4 pt-4 border-t border-line/60 animate-in fade-in duration-150 [overflow-wrap:anywhere]">
                        {entry.scores && (
                          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                            {DIMENSIONS.map((d) => (
                              <div key={d.key} className="rounded-xl border border-line/60 bg-surface/40 p-3 text-center">
                                <p className="text-xs text-muted">{d.label}</p>
                                <p
                                  className={`mt-1 font-mono text-2xl font-bold tabular-nums ${scoreTextCls(
                                    entry.scores![d.key]
                                  )}`}
                                >
                                  {entry.scores![d.key]}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* 我的现场作答 */}
                          <div className="rounded-xl border border-line bg-surface/30 p-4 space-y-2">
                            <span className="text-xs font-bold text-muted flex items-center gap-1.5">
                              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                              <span>我的现场作答</span>
                            </span>
                            {entry.answer ? (
                              <p className="whitespace-pre-wrap text-xs text-ink/80 leading-relaxed font-sans">
                                {entry.answer}
                              </p>
                            ) : (
                              <p className="text-xs text-faint">收藏时尚未录入作答。</p>
                            )}
                          </div>

                          {/* 练习参考答案 */}
                          <div className="rounded-xl border border-primary/25 bg-primary-soft/30 p-4 space-y-2">
                            <span className="text-xs font-bold text-primary flex items-center gap-1.5">
                              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                              <span>练习参考答案</span>
                            </span>
                            {entry.reference ? (
                              <p className="whitespace-pre-wrap text-xs text-ink leading-relaxed font-sans">
                                {entry.reference}
                              </p>
                            ) : (
                              <p className="text-xs text-faint">暂无练习参考答案。</p>
                            )}
                          </div>
                        </div>

                        {/* 点评建议 */}
                        {entry.comment && (
                          <div className="rounded-xl border border-line/70 bg-card p-4 space-y-1.5">
                            <h4 className="text-xs font-bold text-muted">考官针对性点评：</h4>
                            <p className="whitespace-pre-wrap text-xs text-ink/90 leading-relaxed font-sans">
                              {entry.comment}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : nextCursor || hasFilter ? (
            <p className="mt-3 text-sm text-faint">{nextCursor ? "本页错题已移除，可以继续加载更早的收藏。" : "没有匹配的错题，试试调整分类、来源或关键词。"}</p>
          ) : null}

          {nextCursor && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                className={btnPrimary}
                onClick={loadEntries}
                disabled={loadingMore}
              >
                {loadingMore
                  ? "正在加载"
                  : failedCursor === nextCursor
                    ? "重试加载更多"
                    : "加载更多"}
              </button>
            </div>
          )}
        </>}
      </div>

      {entries === null && !loadError && (
        <div className="mt-8" role="status" aria-label="错题列表加载中">
          <div className="skeleton h-6 w-32 rounded-md" />
          <div className="skeleton mt-3 h-20 w-full rounded-xl" />
          <div className="skeleton mt-2 h-20 w-full rounded-xl" />
        </div>
      )}

      {entries !== null && entries.length === 0 && !nextCursor && !hasFilter && (
        <Empty>
          还没有收藏任何错题。可从真实面试复盘、题目练习或模拟面试中收录薄弱题目。
        </Empty>
      )}

      {categoriesError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-wash p-4 text-sm text-danger">
          <span>分类加载失败：{categoriesError}</span>
          <button type="button" className={btnPrimary} onClick={reloadCategories}>重试加载</button>
        </div>
      )}
      {loadError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-wash p-4 text-xs text-danger">
          <span>{loadError}</span>
          {failedCursor === null && (
            <button type="button" className={btnPrimary} onClick={reloadList}>
              重试加载
            </button>
          )}
        </div>
      )}

      {manageOpen && (
        <CategoryManageDialog onClose={closeCategories} onChanged={afterChange} />
      )}
      {movingEntry && (
        <CategoryChangeDialog
          entryId={movingEntry.id}
          question={movingEntry.question}
          initialCategoryId={movingEntry.category_id}
          onClose={closeCategories}
          onSaved={afterChange}
        />
      )}
    </div>
  );
}
