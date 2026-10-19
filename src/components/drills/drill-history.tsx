"use client";

import Link from "next/link";
import type { DrillItem, ProjectBrief } from "@/hooks/use-drills-page";
import { btnDanger, btnPrimary, inputCls } from "@/lib/ui";
import { LoadError } from "@/components/common/ui-bits";

function drillTitle(drill: DrillItem): string {
  if (drill.source === "project") return drill.project_name ?? "未命名项目";
  if (drill.source === "interview") return drill.focus ? `面试追练 · ${drill.focus}` : "面试追练";
  return drill.direction || `JD：${drill.jd.slice(0, 24)}${drill.jd.length > 24 ? "…" : ""}`;
}

const SOURCE_BADGES: Record<string, string> = {
  bank: "通用题库",
  interview: "面试追练",
  project: "项目深挖",
};

export function DrillHistory({
  projects,
  drills,
  nextCursor,
  loadingMore,
  loadError,
  failedCursor,
  filterProject,
  keyword,
  onFilterProjectChange,
  onKeywordChange,
  onLoad,
  onRemove,
}: {
  projects: ProjectBrief[] | null;
  drills: DrillItem[] | null;
  nextCursor: string | null;
  loadingMore: boolean;
  loadError: string;
  failedCursor: string | null | undefined;
  filterProject: number | "";
  keyword: string;
  onFilterProjectChange: (projectId: number | "") => void;
  onKeywordChange: (keyword: string) => void;
  onLoad: (cursor?: string) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <>
      {loadError && (
        <LoadError message={loadError} onRetry={() => onLoad(failedCursor ?? undefined)} />
      )}

      {/* 练习记录卡片阵列 */}
      {drills !== null && (drills.length > 0 || filterProject !== "" || keyword.trim() !== "") && (
        <div className="mt-10 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
              <h2 className="font-serif text-base font-bold text-ink">精练历史记录</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-44">
                <select
                  aria-label="按项目过滤"
                  className={inputCls}
                  value={filterProject}
                  onChange={(event) => onFilterProjectChange(
                    event.target.value === "" ? "" : Number(event.target.value),
                  )}
                >
                  <option value="">全部项目</option>
                  {(projects ?? []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-64">
                <input
                  type="search"
                  aria-label="搜索练习记录"
                  placeholder="搜索题目、回答或方向关键词…"
                  className={inputCls}
                  value={keyword}
                  onChange={(event) => onKeywordChange(event.target.value)}
                />
              </div>
            </div>
          </div>

          {drills.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {drills.map((drill) => (
                  <div
                    key={drill.id}
                    className="group flex flex-col justify-between rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all duration-150 hover:border-primary/40 hover:bg-surface/30"
                  >
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <Link
                            href={`/drills/${drill.id}`}
                            className="font-serif text-base font-bold text-ink hover:text-primary transition-colors line-clamp-1"
                          >
                            {drillTitle(drill)}
                          </Link>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {SOURCE_BADGES[drill.source] && (
                              <span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                                {SOURCE_BADGES[drill.source]}
                              </span>
                            )}
                            <span className="rounded border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-muted">
                              {drill.answered}/{drill.total} 题完成
                            </span>
                            {drill.answered === drill.total && drill.total > 0 && (
                              <span className="rounded bg-surface px-2 py-0.5 text-[10px] text-muted font-medium">
                                已完成
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-between border-t border-line/60 pt-3 text-xs">
                      <span className="font-mono text-[11px] text-faint">
                        {new Date(drill.created_at).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onRemove(drill.id)}
                          className={btnDanger}
                        >
                          删除
                        </button>
                        <Link href={`/drills/${drill.id}`} className={btnPrimary}>
                          {drill.answered === drill.total && drill.total > 0 ? "查看批改" : "继续练习"}
                        </Link>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {nextCursor && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    className={btnPrimary}
                    onClick={() => onLoad(failedCursor ?? nextCursor)}
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
            </>
          ) : (
            <p className="mt-3 text-sm text-faint">没有匹配的练习记录，试试调整项目或关键词。</p>
          )}
        </div>
      )}

      {drills === null && !loadError && (
        <div className="mt-10" role="status" aria-label="练习记录加载中">
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
