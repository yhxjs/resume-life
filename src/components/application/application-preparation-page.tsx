"use client";

import Link from "next/link";
import { useState } from "react";
import { useApplicationPreparation } from "@/hooks/use-application-preparation";
import { useTaskReferenceTime } from "@/hooks/use-task-reference-time";
import { Loading, PageHeader, SectionTitle } from "@/components/common/ui-bits";
import { ApplicationDialog } from "@/components/application/application-dialog";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";
import { ApplicationVersionsDialog } from "@/components/application/application-versions-dialog";
import { ApplicationInterviewRoundDialog } from "@/components/application/application-interview-round-dialog";
import { ApplicationInterviewReviewDialog } from "@/components/application/application-interview-review-dialog";
import { PreparationResourcePicker } from "@/components/application/preparation-resource-picker";
import { PreparationRecordDialog } from "@/components/application/preparation-record-dialog";
import { PREPARATION_KINDS, PREPARATION_LABELS, type PreparationKind, type PreparationResource } from "@/lib/application-preparation-types";
import { STAGE_CONFIG, ROUND_STATUS_CONFIG, type ApplicationInterview } from "@/lib/applications-types";
import { formatFriendlyDateTime, fromLocalDateTime } from "@/lib/application-datetime";
import { getTaskUrgency } from "@/lib/application-calendar";
import { btnGhost, btnPrimary, inputCls } from "@/lib/ui";

export function ApplicationPreparationPage({ id }: { id: string }) {
  const taskReferenceTime = useTaskReferenceTime();
  const { data, error, busy, notice, reload, mutate, toggleTask, generate, loadMore } = useApplicationPreparation(id);
  const [editing, setEditing] = useState(false);
  const [versions, setVersions] = useState(false);
  const [round, setRound] = useState<ApplicationInterview | null | undefined>();
  const [reviewRound, setReviewRound] = useState<ApplicationInterview | null>(null);
  const [picker, setPicker] = useState<PreparationKind | null>(null);
  const [record, setRecord] = useState<{ kind: "diagnosis" | "notebook"; item: PreparationResource } | null>(null);
  const [task, setTask] = useState("");
  const [taskDue, setTaskDue] = useState("");
  if (!data) return <div className="mx-auto max-w-7xl"><Link href="/applications" className={btnGhost}>← 求职看板</Link>{error ? <div role="alert" className="mt-6 space-y-3"><p className="text-danger">{error}</p><button className={btnGhost} onClick={() => void reload()}>重新加载</button></div> : <Loading label="加载投递准备资料…" />}</div>;
  const app = data.application;
  const canGenerate = Boolean(app.jd.trim() && app.resume_id && app.resume_version_id);
  const mockHref = `/interviews?applicationId=${app.id}`;
  return <div className="mx-auto max-w-7xl space-y-6">
    <Link href="/applications" className="inline-flex rounded text-sm text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-primary">← 求职看板</Link>
    <PageHeader title={`${app.company} · ${app.role}`} desc="投递准备 · 把这次机会的资料与下一步行动放在一起。" />
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className={`rounded-full px-3 py-1 ${STAGE_CONFIG[app.stage].bg} ${STAGE_CONFIG[app.stage].color}`}>{STAGE_CONFIG[app.stage].label}</span>
      {app.resume_id ? <Link className="rounded text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-primary" href={app.resume_version_id ? `/resumes/${app.resume_id}/versions?version=${app.resume_version_id}` : `/resumes/${app.resume_id}?applicationId=${app.id}`}>{app.resume_title || "关联简历"}</Link> : <span className="text-muted">尚未关联简历</span>}
      <button className={btnGhost} onClick={() => setEditing(true)} disabled={Boolean(busy)}>编辑投递</button>
      <ResumeVersionBadge {...app} />
      <button className={btnGhost} onClick={() => setVersions(true)}>查看投递版本</button>
      {canGenerate && <Link href={mockHref} className={btnPrimary}>发起模拟面试 →</Link>}
    </div>
    {!canGenerate && <p className="rounded-lg bg-accent-wash p-3 text-sm text-accent">{!app.jd.trim() ? "请先补充岗位 JD" : "请先关联已发布的简历版本"}，即可使用本次投递资料生成准备内容。<button className="ml-2 rounded underline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => setEditing(true)}>去补充</button></p>}
    <details className="rounded-xl border border-line bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold">岗位要求（JD）<span className="ml-3 font-normal text-muted">{app.jd.trim() ? "已保存 · 生成时自动带入" : "待补充"}</span></summary>
      <p className="mt-4 max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed">{app.jd || "暂未填写岗位要求。"}</p>
    </details>
    {(busy || notice) && <p role="status" className="text-sm text-primary">{busy ? `${busy}中，请稍候…` : notice}</p>}
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-danger-wash p-3 text-sm text-danger"><p>{error}</p><button className={btnGhost} onClick={() => void reload()} disabled={Boolean(busy)}>刷新资料</button></div>}
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-8">
        {PREPARATION_KINDS.filter((kind) => kind !== "series").map((kind) => {
          const page = data.resources[kind];
          const kinds = kind === "interview" ? ["interview", "series"] as const : [kind];
          const count = (page.total ?? 0) + (kind === "interview" ? data.resources.series.total ?? 0 : 0);
          return <section key={kind} aria-label={PREPARATION_LABELS[kind]} className="min-w-0 border-b border-line pb-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionTitle count={count}>{PREPARATION_LABELS[kind]}</SectionTitle>
              <div className="flex flex-wrap gap-2">
                <button className={btnGhost} disabled={Boolean(busy)} onClick={() => setPicker(kind)}>关联已有{PREPARATION_LABELS[kind]}</button>
                {(kind === "diagnosis" || kind === "intro" || kind === "portrait") && <button className={btnGhost} disabled={Boolean(busy) || (kind === "portrait" ? !app.jd.trim() : !canGenerate)} onClick={() => void generate(kind)}>生成{PREPARATION_LABELS[kind]}</button>}
                {kind === "interview" && <button className={btnGhost} disabled={Boolean(busy)} onClick={() => setPicker("series")}>关联进阶面试</button>}
              </div>
            </div>
            {count === 0 && <p className="py-6 text-sm text-muted">{kind === "notebook" ? "暂无错题。从本次投递的真实面试复盘或模拟面试收录后，会出现在这里，也可关联已有错题。" : `暂无${PREPARATION_LABELS[kind]}，可以关联已有记录${kind === "interview" ? "或发起一场模拟面试。" : "或使用当前投递资料生成。"}`}</p>}
            {kinds.map((resourceKind) => <div key={resourceKind}>
              <ul className="mt-2 divide-y divide-line">
                {data.resources[resourceKind].items.map((item) => <li key={item.id} className="py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><h3 className="min-w-0 break-words text-sm font-semibold">{resourceKind === "series" ? "进阶面试 · " : ""}{item.title}</h3><span className="shrink-0 text-xs text-muted">#{item.id} · {item.created_at ? new Date(item.created_at).toLocaleDateString() : "历史记录"}</span></div>
                  <p className="mt-2 max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{item.summary || "已关联，查看完整记录继续准备。"}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {item.href ? <Link className={btnGhost} href={`${item.href}?applicationId=${app.id}`}>查看记录 →</Link> : <button className={btnGhost} onClick={() => setRecord({ kind: resourceKind as "diagnosis" | "notebook", item })}>查看{PREPARATION_LABELS[resourceKind]}</button>}
                    {(item.linked || resourceKind === "interview" || resourceKind === "series") && <button className={btnGhost} disabled={Boolean(busy)} onClick={() => void mutate("resources", "DELETE", { kind: resourceKind, id: item.id }, "取消关联")}>取消关联</button>}
                    {resourceKind === "notebook" && !item.linked && <span className="text-xs text-muted">来自关联的模拟面试</span>}
                  </div>
                </li>)}
              </ul>
              {data.resources[resourceKind].nextCursor && <button className={btnGhost} disabled={Boolean(busy)} onClick={() => void loadMore(resourceKind)}>更多{PREPARATION_LABELS[resourceKind]}</button>}
            </div>)}
          </section>;
        })}
      </div>
      <aside className="min-w-0 space-y-8">
        <section aria-label="准备待办" className="rounded-xl border border-line bg-card p-5">
          <SectionTitle count={data.tasks.filter((item) => !item.done).length}>准备待办</SectionTitle>
          <form className="mt-4 space-y-2" onSubmit={async (event) => {
            event.preventDefault();
            const dueIso = taskDue ? fromLocalDateTime(taskDue) : "";
            if (await mutate("tasks", "POST", { title: task, due_time: dueIso }, "添加待办")) {
              setTask("");
              setTaskDue("");
            }
          }}>
            <div className="flex gap-2">
              <input aria-label="新待办" className={`${inputCls} min-w-0 flex-1`} placeholder="下一步要准备什么？" maxLength={200} value={task} onChange={(event) => setTask(event.target.value)} disabled={Boolean(busy)} />
              <button type="submit" className={btnPrimary} disabled={Boolean(busy) || !task.trim()}>添加</button>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>截止时间:</span>
              <input
                type="datetime-local"
                className={`${inputCls} py-0.5 px-1.5 text-xs w-auto bg-surface`}
                value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)}
                disabled={Boolean(busy)}
                title="选填截止时间，便于在日历中提醒"
              />
              {taskDue && (
                <button
                  type="button"
                  onClick={() => setTaskDue("")}
                  className="text-muted hover:text-ink text-[11px]"
                >
                  清除
                </button>
              )}
            </div>
          </form>
          <ul className="mt-3 divide-y divide-line">{data.tasks.map((item) => {
            const urgency = getTaskUrgency(item.due_time, taskReferenceTime);
            return (
              <li key={item.id} className="flex items-start gap-3 py-3">
                <label className="flex min-w-0 flex-1 items-start gap-3 text-sm leading-relaxed">
                  <input type="checkbox" className="mt-1 accent-primary" checked={item.done} disabled={Boolean(busy)} onChange={(event) => void toggleTask(item.id, event.target.checked)} />
                  <div className="min-w-0 flex-1">
                    <span className={`break-words ${item.done ? "text-muted line-through" : ""}`}>{item.title}</span>
                    {item.due_time && (
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs">
                        <span className="text-muted">截止: {formatFriendlyDateTime(item.due_time)}</span>
                        {!item.done && urgency.hasDue && (
                          <span
                            className={`rounded px-1.5 py-0.2 text-[10px] font-medium border ${
                              urgency.isOverdue
                                ? "bg-danger-wash text-danger border-danger/30"
                                : urgency.isDueToday
                                ? "bg-accent/15 text-accent border-accent/20"
                                : "bg-surface text-faint border-line"
                            }`}
                          >
                            {urgency.label}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </label>
                <button className="rounded px-1 text-sm text-muted hover:text-danger focus-visible:outline-2 focus-visible:outline-primary" aria-label={`删除待办：${item.title}`} disabled={Boolean(busy)} onClick={() => void mutate("tasks", "DELETE", { id: item.id }, "删除待办")}>×</button>
              </li>
            );
          })}</ul>
          {data.tasks.length === 0 && <p className="mt-4 text-sm leading-relaxed text-muted">记下需要补强的知识点、要问面试官的问题，或面试后的跟进事项。</p>}
        </section>
        <section aria-label="真实面试记录">
          <SectionTitle count={app.interviews?.length ?? 0} right={<button className={btnGhost} onClick={() => setRound(null)}>记面试</button>}>真实面试记录</SectionTitle>
          <ul className="mt-3 divide-y divide-line">{app.interviews?.map((item) => <li key={item.id} className="py-4">
            <div className="flex items-center justify-between gap-3"><h3 className="break-words text-sm font-semibold">{item.round_name}</h3><span className={`shrink-0 text-xs ${ROUND_STATUS_CONFIG[item.status].color}`}>{ROUND_STATUS_CONFIG[item.status].label}</span></div>
            <p className="mt-2 text-xs text-muted">{item.interview_time ? formatFriendlyDateTime(item.interview_time) : "时间待定"}{item.interviewer ? ` · ${item.interviewer}` : ""}</p>
            {item.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.notes}</p>}
            <div className="mt-3 flex flex-wrap gap-2"><button className={btnGhost} onClick={() => setRound(item)}>编辑记录</button><button className={btnGhost} onClick={() => setReviewRound(item)}>逐题复盘</button></div>
          </li>)}</ul>
          {!app.interviews?.length && <p className="mt-4 text-sm text-muted">暂无记录，记下约定时间、面试问题与复盘。</p>}
        </section>
        {app.notes && <section><SectionTitle>投递备忘</SectionTitle><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{app.notes}</p></section>}
      </aside>
    </div>
    {editing && <ApplicationDialog initialData={app} onClose={() => setEditing(false)} onSuccess={() => { setEditing(false); void reload(); }} />}
    {versions && <ApplicationVersionsDialog application={app} onClose={() => setVersions(false)} />}
    {round !== undefined && <ApplicationInterviewRoundDialog application={app} initialInterview={round} open onClose={() => setRound(undefined)} onSuccess={() => void reload()} />}
    {reviewRound && <ApplicationInterviewReviewDialog application={app} interview={reviewRound} onClose={() => { setReviewRound(null); void reload(); }} />}
    {picker && <PreparationResourcePicker applicationId={app.id} kind={picker} onClose={() => setPicker(null)} onSelect={(resourceId) => mutate("resources", "POST", { kind: picker, id: resourceId }, "关联资料")} />}
    {record && <PreparationRecordDialog kind={record.kind} record={record.item} applicationId={app.id} onClose={() => setRecord(null)} />}
  </div>;
}
