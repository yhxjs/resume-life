"use client";

import { useCallback } from "react";
import { useCursorList } from "@/hooks/use-cursor-list";
import type { ProjectSummaryHistoryItem } from "@/lib/project-summary-history";
import { RESUME_SUMMARY_LABELS, SUMMARY_SECTIONS } from "@/lib/summary";
import { btnGhost } from "@/lib/ui";

const SOURCE_LABELS = { ai: "AI 总结", repo: "仓库扫描", manual: "手动保存" } as const;

export function ProjectSummaryHistory({ projectId, revisionId }: { projectId: number; revisionId: number }) {
  const buildUrl = useCallback((cursor?: string) =>
    `/api/projects/${projectId}/summary-history?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  [projectId]);
  const history = useCursorList<ProjectSummaryHistoryItem>({ queryKey: `${projectId}:${revisionId}`, buildUrl, delay: 0 });

  return (
    <section role="region" aria-label="总结历史" className="border-t border-line pt-5">
      <h2 className="text-base font-semibold text-ink">总结历史</h2>
      {history.listError && <p className="mt-3 text-xs text-danger">{history.listError}</p>}
      {history.items?.length === 0 && <p className="mt-3 text-xs text-muted">尚无已保存的总结。</p>}
      <div className="mt-3 divide-y divide-line border-y border-line">
        {history.items?.map((item) => (
          <details key={item.id} className="group py-3">
            <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-xs text-ink marker:text-muted">
              <span className="font-medium">{SOURCE_LABELS[item.source]}</span>
              <time className="text-muted" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time>
              <span className="text-faint">#{item.id}</span>
            </summary>
            <div className="mt-3 space-y-3 pl-4 text-xs">
              {SUMMARY_SECTIONS.map(({ key, label }) => item.summary[key] && (
                <div key={key}><h3 className="font-medium text-muted">{label}</h3><p className="mt-1 whitespace-pre-wrap break-words text-ink">{item.summary[key]}</p></div>
              ))}
              {(["techStack", "brief"] as const).map((key) => item.summary[key] && (
                <div key={key}><h3 className="font-medium text-muted">{RESUME_SUMMARY_LABELS[key]}</h3><p className="mt-1 whitespace-pre-wrap break-words text-ink">{item.summary[key]}</p></div>
              ))}
              {item.summary.achievements.length > 0 && (
                <div><h3 className="font-medium text-muted">{RESUME_SUMMARY_LABELS.achievements}</h3>
                  <ol className="mt-1 list-decimal space-y-1 pl-5 text-ink">{item.summary.achievements.map((text, index) => <li key={index} className="whitespace-pre-wrap break-words">{text}</li>)}</ol>
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
      {history.hasMore && (
        <button type="button" className={`${btnGhost} mt-3`} onClick={history.loadMore} disabled={history.loadingMore}>
          {history.loadingMore ? "加载中…" : "加载更早的总结"}
        </button>
      )}
    </section>
  );
}
