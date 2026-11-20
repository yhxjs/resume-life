"use client";

import { useId } from "react";
import { MAX_EVIDENCE_RECOMMENDATIONS } from "@/lib/evidence-challenge";
import { btnPrimary } from "@/lib/ui";

export function RecommendationSparkles({ className = "h-4 w-4" }: { className?: string }) {
  return <svg aria-hidden="true" className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3Z" />
    <path d="M20 2v4m-2-2h4" />
  </svg>;
}

export function EvidenceRecommendationCard({ count, onCountChange, busy, disabled, onGenerate }: {
  count: number; onCountChange: (count: number) => void; busy: boolean; disabled: boolean; onGenerate: () => void;
}) {
  const countId = useId();
  return <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-linear-to-br from-primary-soft/70 via-card to-accent-wash/40 p-4 shadow-card-subtle sm:p-5">
    <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-14 h-36 w-36 rounded-full bg-primary/5" />
    <div className="relative flex items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-card/80 text-primary shadow-sm"><RecommendationSparkles className="h-5 w-5" /></span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">让材料决定追问方向</h3>
          <span className="rounded-full border border-primary/15 bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-primary">AI 推荐</span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">AI 根据当前选中的摘录，自动识别值得深挖的实现细节、设计取舍与条件变化，生成可直接练习的题目，无需填写追问方式。</p>
      </div>
    </div>
    <div className="relative mt-5 border-t border-primary/15 pt-4">
      <fieldset>
        <legend className="mb-2 text-xs font-medium text-ink">生成数量<span className="ml-2 font-normal text-muted">最多 {MAX_EVIDENCE_RECOMMENDATIONS} 题</span></legend>
        <div className="grid max-w-sm grid-cols-5 gap-2">
          {Array.from({ length: MAX_EVIDENCE_RECOMMENDATIONS }, (_, index) => index + 1).map(number => <label key={number} className="cursor-pointer">
            <input type="radio" className="peer sr-only" name={countId} value={number} checked={count === number} onChange={() => onCountChange(number)} aria-label={`${number} 题`} />
            <span className="flex min-h-10 items-center justify-center gap-1 rounded-xl border border-line bg-card/80 text-sm text-muted transition-colors peer-checked:border-primary peer-checked:bg-primary peer-checked:text-on-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary peer-disabled:cursor-wait"><span className="font-semibold tabular-nums">{number}</span><span className="text-[11px]">题</span></span>
          </label>)}
        </div>
      </fieldset>
      <p className="mt-3 text-xs leading-relaxed text-muted">每题保留来源、位置与摘录。材料不足时会减少题目，避免重复凑数。</p>
      <button type="button" className={`${btnPrimary} mt-4 w-full gap-2 py-2.5 sm:w-auto sm:min-w-48`} disabled={disabled || busy} onClick={onGenerate}>
        {busy ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" /> : <RecommendationSparkles />}
        {busy ? "正在生成推荐题…" : "一键生成推荐题"}
      </button>
    </div>
  </div>;
}
