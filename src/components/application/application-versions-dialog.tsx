"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type { Application, ApplicationVersions } from "@/lib/applications-types";
import { compareApplicationVersions } from "@/lib/application-version-diff";
import { formatFriendlyDateTime } from "@/lib/application-datetime";
import { resumeToMarkdown } from "@/lib/resume-markdown";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { btnGhost, dialogCardCls, modalOverlayCls } from "@/lib/ui";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { InlineError } from "@/components/common/inline-error";

const views = { submitted: "投递版", current: "当前版", diff: "查看差异" } as const;
const statuses = { unchanged: "未变化", added: "新增", removed: "已移除", changed: "已修改" } as const;

function Content({ text, empty = "未填写" }: { text: string | null; empty?: string }) {
  return <pre className="min-w-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">{text || empty}</pre>;
}

export function ApplicationVersionsDialog({ application, onClose }: { application: Pick<Application, "id" | "company" | "role">; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useModalFocus(true, onClose);
  const [data, setData] = useState<ApplicationVersions | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<keyof typeof views>("submitted");
  const [onlyChanges, setOnlyChanges] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<ApplicationVersions>(`/api/applications/${application.id}/versions`, { signal: controller.signal })
      .then((versions) => { if (!controller.signal.aborted) setData(versions); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [application.id, reload]);

  const rows = data ? compareApplicationVersions(data) : [];
  const changed = rows.filter((row) => row.status !== "unchanged");
  const shown = onlyChanges ? changed : rows;
  const selected = view === "submitted" ? data?.submitted : data?.current;

  return (
    <div className={modalOverlayCls} data-modal-overlay onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className={`${dialogCardCls} max-w-5xl max-h-[90dvh] overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-primary`}>
        <div className="flex items-start justify-between gap-3 border-b border-line pb-4">
          <div className="min-w-0">
            <h2 id={titleId} className="break-words font-serif text-lg font-bold text-ink">{application.company} · {application.role} · 投递版本</h2>
            <p className="mt-1 text-xs text-muted">回看标记已投递时保存的简历正文与 JD，或与当前关联内容比较。</p>
          </div>
          <button type="button" className={btnGhost} onClick={onClose} aria-label="关闭投递版本">关闭</button>
        </div>

        {error ? <div className="mt-4"><InlineError message={error} onRetry={() => { setError(""); setReload((value) => value + 1); }} /></div> :
          !data ? <p role="status" className="py-8 text-sm text-muted">正在读取投递版本…</p> : (
            <div className="mt-4 space-y-5">
              {data.submitted ? (
                <p className="text-sm text-muted">投递版保存于 <time dateTime={data.submitted.captured_at}>{formatFriendlyDateTime(data.submitted.captured_at)}</time>，后续编辑不会覆盖。</p>
              ) : (
                <p className="rounded-lg border border-line bg-surface p-3 text-sm text-muted">暂无投递快照，首次标记已投递时保存。</p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2" role="group" aria-label="版本视图">
                  {(Object.keys(views) as (keyof typeof views)[]).map((key) => (
                    <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}
                      className={`${btnGhost} ${view === key ? "!border-primary !bg-primary-soft" : ""}`}>{views[key]}</button>
                  ))}
                </div>
                {data.current.resume && <Link className="text-sm text-primary underline underline-offset-4" href={`/resumes/${data.current.resume.id}`}>编辑当前简历 →</Link>}
              </div>
              {data.submitted?.resume && data.current.resume && data.submitted.resume.id !== data.current.resume.id && (
                <p className="text-sm text-muted">当前关联已更换为「{data.current.resume.title}」，投递版仍是「{data.submitted.resume.title}」。</p>
              )}
              {view !== "submitted" && data.current.warnings.length > 0 && (
                <InlineError message="当前简历有损坏模块，请先修复；投递版仍可回看，暂不比较差异。" />
              )}

              {view === "diff" ? (
                !data.submitted ? <p className="text-sm text-muted">没有投递快照，暂时无法比较差异。可切换到当前版查看现有内容。</p> :
                  data.current.warnings.length === 0 && <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                      <p role="status" className="text-ink">{changed.length ? `${changed.length} 处变化` : "正文与 JD 均无变化"}</p>
                      <label className="flex items-center gap-2 text-muted"><input type="checkbox" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />仅看变化</label>
                    </div>
                    {!data.current.resume && <p className="text-sm text-muted">当前未关联简历，或源简历已删除；投递版内容仍完整保留。</p>}
                    <p className="text-xs text-muted">按模块比较正文与顺序，保留加粗和列表标记；头像、页面模板和间距不计入差异。</p>
                    {shown.map((row) => (
                      <section key={row.key} className="border-t border-line pt-4" aria-label={`${row.label}差异`}>
                        <h3 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">{row.label}
                          <span className={`rounded px-2 py-0.5 text-xs ${row.status === "unchanged" ? "bg-surface text-muted" : "bg-accent-wash text-accent"}`}>{statuses[row.status]}{row.moved ? " · 顺序调整" : ""}</span>
                        </h3>
                        <div className="grid min-w-0 gap-4 md:grid-cols-2">
                          <div className="min-w-0 rounded-lg bg-surface p-3"><p className="mb-2 text-xs font-semibold text-muted">投递版</p><Content text={row.before} empty={row.before === null ? "此版本无此内容" : "未填写"} /></div>
                          <div className="min-w-0 rounded-lg bg-surface p-3"><p className="mb-2 text-xs font-semibold text-muted">当前版</p><Content text={row.after} empty={row.after === null ? "此版本无此内容" : "未填写"} /></div>
                        </div>
                      </section>
                    ))}
                  </div>
              ) : selected && (
                <div className="space-y-5">
                  <section aria-label={`${views[view]}简历正文`}>
                    <h3 className="mb-3 font-serif font-semibold text-ink">简历正文</h3>
                    {selected.resume ? <Content text={resumeToMarkdown(selected.resume.title, selected.resume.modules)} /> :
                      <p className="text-sm text-muted">{view === "submitted" ? "标记已投递时未关联简历，未保存简历正文。" : "当前未关联简历，或源简历已删除。"}</p>}
                  </section>
                  <section className="border-t border-line pt-4" aria-label={`${views[view]}岗位 JD`}>
                    <h3 className="mb-3 font-serif font-semibold text-ink">岗位 JD</h3>
                    <Content text={selected.jd} empty={view === "submitted" ? "标记已投递时未填写 JD。" : "当前未填写 JD。"} />
                  </section>
                </div>
              )}
            </div>
          )}
      </div>
    </div>
  );
}
