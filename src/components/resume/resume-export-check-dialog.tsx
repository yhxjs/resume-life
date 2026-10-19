"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/common/modal";
import { inspectResumeForExport, type ResumeExportCheckInput, type ResumeExportIssue, type ResumeExportIssueKind } from "@/lib/resume-export-check";
import { errorMessage } from "@/lib/error-message";
import { btnDangerSolid, btnGhost, btnPrimary } from "@/lib/ui";

type Props = Omit<ResumeExportCheckInput, "confirmedIssueIds"> & {
  open: boolean;
  onClose: () => void;
  onLocate: (issue: ResumeExportIssue) => void;
  onContinue: (confirmedIssueIds: string[], skipExportCheck: boolean) => void | Promise<void>;
  continueLabel?: string;
};

const GROUPS: { kind: ResumeExportIssueKind; label: string }[] = [
  { kind: "unconfirmed_metric", label: "未确认数字" },
  { kind: "placeholder", label: "残留占位符" },
  { kind: "contact", label: "联系方式" },
  { kind: "pagination", label: "分页问题" },
];

// 关闭即销毁本次确认，不写入存储，也不沿用上一次导出的勾选。
export function ResumeExportCheckDialog(props: Props) {
  return props.open ? <ExportCheckSession {...props} /> : null;
}

function ExportCheckSession({ onClose, onLocate, onContinue, continueLabel = "继续导出", ...input }: Props) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const result = inspectResumeForExport(input);
  const remaining = result.blockingIssues.filter((issue) => issue.kind !== "unconfirmed_metric" || !confirmed.has(issue.id));

  async function proceed(skipExportCheck = false) {
    if ((!skipExportCheck && remaining.length) || busy) return;
    setBusy(true);
    setError("");
    try {
      await onContinue(skipExportCheck ? [] : result.issues.filter((issue) => issue.kind === "unconfirmed_metric" && confirmed.has(issue.id)).map((issue) => issue.id), skipExportCheck);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const dialog = (
    <Modal
      open
      title="导出前检查"
      onClose={onClose}
      loading={busy}
      loadingText="正在准备导出简历…"
      loadingDescription="正在核对导出配置与资源，请稍候…"
    >
      <div className="no-print space-y-4">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-serif text-lg font-bold text-ink">导出前检查</h2>
            <button type="button" className={btnDangerSolid} disabled={busy} onClick={() => void proceed(true)}>我已确认，无需核对</button>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted">核实数字后可逐条或全部勾选；常规导出需修改占位符和示例标记。联系方式与分页是提醒，不阻止导出。</p>
        </div>
        <p role="status" className="rounded-lg bg-surface p-3 text-sm text-ink">
          {remaining.length ? "还有 " + remaining.length + " 项需要处理" : "阻断项已处理，可以继续"}
          {" · " + result.warningIssues.length + " 项提醒"}
        </p>
        <div className="space-y-4">
          {GROUPS.map((group) => {
            const issues = result.issues.filter((issue) => issue.kind === group.kind);
            return (
              <section key={group.kind} aria-label={group.label}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-ink">{group.label} <span className="font-mono text-xs text-muted">{issues.length}</span></h3>
                  {group.kind === "unconfirmed_metric" && issues.length > 0 && (
                    <button type="button" className="text-xs text-primary underline underline-offset-2 disabled:opacity-50"
                      disabled={busy || issues.every((issue) => confirmed.has(issue.id))}
                      onClick={() => setConfirmed((previous) => new Set([...previous, ...issues.map((issue) => issue.id)]))}>
                      全部勾选
                    </button>
                  )}
                </div>
                {issues.length === 0 ? <p className="text-xs text-muted">未发现{group.kind === "pagination" ? "明显风险（以打印预览为准）" : "问题"}</p> : (
                  <ul className="divide-y divide-line rounded-lg border border-line">
                    {issues.map((issue) => (
                      <li key={issue.id} className="space-y-2 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="min-w-0 break-words text-xs font-medium text-ink">
                            {issue.moduleLabel}{issue.entryIndex !== undefined ? " · 第 " + (issue.entryIndex + 1) + " 条" : ""}
                            {issue.entryLabel ? " · " + issue.entryLabel : ""}
                            {issue.inExportedContent ? "（脱敏替换后）" : ""}
                          </p>
                          <button type="button" className="shrink-0 text-xs text-primary underline underline-offset-2 disabled:opacity-50"
                            disabled={busy} onClick={() => { onClose(); onLocate(issue); }}>定位条目</button>
                        </div>
                        {issue.kind === "unconfirmed_metric" && issue.context && issue.contextMetricOffset !== undefined ? (
                          <p className="break-words text-sm text-ink">
                            {issue.context.slice(0, issue.contextMetricOffset)}
                            {issue.excerpt.split(/(\d+(?:[.,]\d+)*(?:[%％])?\+?)/gu).map((part, index) =>
                              /^\d/.test(part) ? <mark key={index} className="rounded bg-primary px-1 py-0.5 font-bold text-on-primary">{part}</mark> : part)}
                            {issue.context.slice(issue.contextMetricOffset + issue.excerpt.length)}
                          </p>
                        ) : issue.excerpt && <p className="break-words text-sm font-medium text-ink">{issue.excerpt}</p>}
                        {issue.kind !== "unconfirmed_metric" && issue.context && issue.context !== issue.excerpt && <p className="break-words whitespace-pre-wrap text-xs text-muted">{issue.context}</p>}
                        <p className={issue.severity === "blocking" ? "text-xs text-danger" : "text-xs text-muted"}>{issue.message}</p>
                        {issue.kind === "unconfirmed_metric" && (
                          <label className="flex items-start gap-2 text-xs leading-relaxed text-ink">
                            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-(--primary)" checked={confirmed.has(issue.id)} disabled={busy}
                              onChange={(event) => setConfirmed((previous) => {
                                const next = new Set(previous);
                                if (event.target.checked) next.add(issue.id); else next.delete(issue.id);
                                return next;
                              })} />
                            我已核实「{issue.excerpt}」来自真实经历，有依据且口径准确
                          </label>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        <p className="text-xs leading-relaxed text-muted">确认仅用于本次导出。自动检查不能证明数字真实，也无法恢复历史示例的来源；请以实际记录为准。分页按当前模板与页边距估算。</p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>返回修改</button>
          <button type="button" className={btnPrimary} disabled={busy || remaining.length > 0} onClick={() => void proceed()}>{busy ? "正在准备导出…" : continueLabel}</button>
        </div>
      </div>
    </Modal>
  );
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
