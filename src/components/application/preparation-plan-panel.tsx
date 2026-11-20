"use client";

import Link from "next/link";
import { useState } from "react";
import { ApplicationDialog } from "@/components/application/application-dialog";
import { Loading, SectionTitle } from "@/components/common/ui-bits";
import { usePreparationPlan } from "@/hooks/use-preparation-plan";
import { remainingPlanMinutes, type PlanStep, type PlanStepKey } from "@/lib/preparation-plan-types";
import { btnGhost, btnPrimary } from "@/lib/ui";

export function PreparationPlanPanel({ id }: { id: number }) {
  const { data, error, busy, notice, blocked, reload, generate, complete, generateMaterial } = usePreparationPlan(id);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<PlanStepKey | null>(null);
  const disabled = Boolean(busy) || blocked;
  const errorPanel = error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-danger/20 bg-danger-wash p-4 text-sm text-danger"><p className="min-w-0 flex-1">{error}</p><button className={btnGhost} disabled={Boolean(busy)} onClick={() => void reload()}>刷新清单</button></div>;
  if (!data) return <div className="space-y-4"><Link href="/tools/preparation" className={btnGhost}>选择其他岗位</Link>{errorPanel || <Loading label="读取上场计划…" />}</div>;
  const app = data.application;
  const materials = data.steps.filter(step => step.category === "material");
  const missing = materials.filter(step => !step.done);
  const training = data.steps.filter(step => step.category === "training");
  const completed = data.steps.filter(step => step.done).length;
  const minutes = remainingPlanMinutes(data.steps);
  const next = data.steps.find(step => !step.done && !step.blocked);

  function action(step: PlanStep, primary = false) {
    const cls = primary ? btnPrimary : btnGhost;
    if (step.blocked) return <button className={cls} disabled>{step.blocked}</button>;
    if (step.action === "visit" && step.href) return disabled ? <button className={cls} disabled>{step.actionLabel}</button> : <Link href={step.href} className={cls}>{step.actionLabel} →</Link>;
    return <button className={cls} disabled={disabled} onClick={() => {
      if (step.action === "edit") setEditing(true);
      else if (step.action === "generate") void generateMaterial(step);
      else setExpanded(current => current === step.key ? null : step.key);
    }}>{step.action === "practice" && expanded === step.key ? "收起练习" : step.done && step.manual ? "再次练习" : step.actionLabel}</button>;
  }

  function card(step: PlanStep) {
    const open = expanded === step.key;
    return <li key={step.key} className="rounded-xl border border-line bg-card p-5" aria-label={step.title}>
      <div className="flex items-start gap-3">
        <span aria-hidden className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${step.done ? "border-primary/30 bg-primary-soft text-primary" : "border-line text-muted"}`}>{step.done ? "✓" : data!.steps.indexOf(step) + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">{step.title}</h3><span className="shrink-0 text-xs text-muted">{step.done ? "已完成" : `预计 ${step.minutes[0]}–${step.minutes[1]} 分钟`}</span></div>
          <p className="mt-2 text-sm leading-relaxed text-muted">{step.reason}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">{action(step)}{step.manual && step.done && <button className="rounded text-xs text-muted underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-primary" disabled={disabled} onClick={() => void complete(step, false)}>恢复待练</button>}</div>
          {open && <div className="mt-4 space-y-4 rounded-lg bg-surface p-4">
            <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">{step.instructions.map((instruction, index) => <li key={index}>{instruction}</li>)}</ol>
            <div className="flex flex-wrap gap-3">{step.href && <Link href={step.href} className={btnGhost}>打开练习资料 →</Link>}<button className={btnPrimary} disabled={disabled || step.done || Boolean(step.blocked)} onClick={() => void complete(step, true)}>{step.done ? "已完成本项" : "我已完成本项训练"}</button></div>
          </div>}
        </div>
      </div>
    </li>;
  }

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0"><p className="text-xs text-muted">本次准备岗位</p><h2 className="mt-1 break-words font-serif text-xl font-bold">{app.company} · {app.role}</h2></div>
      <div className="flex flex-wrap gap-2"><Link className={btnGhost} href="/tools/preparation">切换岗位</Link><Link className={btnGhost} href={`/applications/${id}/prepare`}>岗位资料</Link><button className={btnGhost} disabled={Boolean(busy)} onClick={() => void reload()}>刷新进度</button></div>
    </div>
    {errorPanel}
    {(busy || notice) && <p role="status" className="text-sm text-primary">{busy ? `${busy}中，请稍候…` : notice}</p>}
    {!data.generatedAt ? <section className="rounded-2xl border border-primary/25 bg-primary-soft/30 p-6 sm:p-8">
      <h3 className="font-serif text-xl font-bold">{data.stale ? "岗位资料已更新，重新安排准备" : "看看离上场，还差哪几步"}</h3>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">{data.stale ? "JD、岗位信息或简历版本已变化。重新生成会按当前资料检查缺项，并重新记录训练进度。" : "检查 JD、投递简历、考点画像、简历诊断与自我介绍，再安排项目表达、重点问题和模拟面试。资料还没齐，也可以先生成清单。"}</p>
      <button className={`${btnPrimary} mt-5`} disabled={disabled} onClick={() => void generate()}>生成本岗位准备清单 →</button>
    </section> : <>
      <section aria-label="准备进度" className="rounded-2xl border border-primary/20 bg-primary-soft/30 p-5 sm:p-7">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[{ label: "待补资料", value: `${missing.length} 项` }, { label: "待完成训练", value: `${training.filter(step => !step.done).length} 项` }, { label: "剩余预计耗时", value: minutes[1] === 0 ? "已完成" : `${minutes[0]}–${minutes[1]} 分钟` }].map(stat => <div key={stat.label}><p className="text-xs text-muted">{stat.label}</p><p className="mt-1 font-serif text-2xl font-bold text-primary">{stat.value}</p></div>)}
        </div>
        <div className="mt-6 flex items-center justify-between text-xs text-muted"><span>已完成 {completed} / {data.steps.length} 项</span><span>{Math.round(completed / data.steps.length * 100)}%</span></div>
        <div role="progressbar" aria-label="准备完成进度" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={data.steps.length} className="mt-2 h-2 overflow-hidden rounded-full bg-primary/10"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${completed / data.steps.length * 100}%` }} /></div>
        <p className="mt-4 text-xs leading-relaxed text-muted">耗时按一次整理或练习估算，包含阅读与核对，可按熟悉程度调整。资料补齐与面试完成自动同步，线下训练由你确认。</p>
      </section>
      {next ? <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line p-4"><div><p className="text-xs text-primary">建议从这里开始</p><p className="mt-1 text-sm font-semibold">{next.title}</p></div>{action(next, true)}</div> : <p role="status" className="rounded-xl bg-primary-soft p-5 text-primary">本轮准备已完成。上场前可以再回顾重点，或选择一项再次练习。</p>}
      <div className="grid items-start gap-8 lg:grid-cols-2">
        <section aria-label="待补资料" className="min-w-0 space-y-4"><SectionTitle count={missing.length}>待补资料</SectionTitle><ul className="space-y-3">{missing.map(card)}</ul>{missing.length === 0 && <p className="rounded-xl border border-line p-5 text-sm text-muted">本岗位的基础准备资料已齐，可以专注训练。</p>}
          {materials.some(step => step.done) && <details className="rounded-xl border border-line bg-card p-4"><summary className="cursor-pointer text-sm text-muted">已齐备资料 · {materials.filter(step => step.done).length} 项</summary><ul className="mt-4 space-y-4">{materials.filter(step => step.done).map(step => <li key={step.key} className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm">✓ {step.title}</span>{action(step)}</li>)}</ul></details>}
          {!app.resume_version_id && <p className="text-xs leading-relaxed text-muted">还没有已发布的简历？<Link className="ml-1 text-primary underline" href={app.resume_id ? `/resumes/${app.resume_id}` : "/resumes"}>前往简历工作台</Link>完成发布后，再关联到这个岗位。</p>}
        </section>
        <section aria-label="建议训练" className="min-w-0 space-y-4"><SectionTitle count={training.filter(step => !step.done).length}>建议训练</SectionTitle><ul className="space-y-3">{training.map(card)}</ul></section>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-xs text-muted"><p>仅核对本投递关联的资料；JD 与简历版本变化后需重新生成。</p><button className={btnGhost} disabled={disabled} onClick={() => void generate()}>更新清单</button></div>
    </>}
    {editing && <ApplicationDialog initialData={app} onClose={() => setEditing(false)} onSuccess={() => { setEditing(false); setExpanded(null); void reload(); }} />}
  </div>;
}
