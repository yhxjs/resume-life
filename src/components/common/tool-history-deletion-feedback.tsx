"use client";

import type { useRecordDeletion } from "@/hooks/use-record-deletion";
import { btnPrimary } from "@/lib/ui";

export function ToolHistoryDeletionFeedback({ deletion, deletingLabel = "正在删除历史记录…" }: { deletion: Omit<ReturnType<typeof useRecordDeletion>, "remove">; deletingLabel?: string }) {
  return <>
    {deletion.target && <p className="text-xs text-muted [overflow-wrap:anywhere]">操作对象：#{deletion.target.id}「{deletion.target.title}」</p>}
    {deletion.error && <p role="alert" className="text-sm text-danger [overflow-wrap:anywhere]">{deletion.error}</p>}
    {deletion.phase === "unknown" && <button type="button" className={btnPrimary} onClick={deletion.retryCheck}>重新读取删除状态</button>}
    {(deletion.phase === "deleting" || deletion.phase === "checking") && <p role="status" className="text-sm text-muted">{deletion.phase === "checking" ? "正在核对删除状态…" : deletingLabel}</p>}
    {deletion.notice && <p role="status" className="text-sm text-muted">{deletion.notice}</p>}
  </>;
}
