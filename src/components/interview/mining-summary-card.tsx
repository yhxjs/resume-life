"use client";

import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import type { MiningSummary } from "@/lib/scores";
import { badgeAccent, badgePrimary, btnGhost, btnPrimary } from "@/lib/ui";

export function MiningSummaryCard({ miningSummary }: { miningSummary: MiningSummary }) {
  const { copiedText, copyError, copying, copy } = useCopyFeedback();
  const allBullets = miningSummary.resume_bullets.map((bullet) => `• ${bullet}`).join("\n");

  return (
    <div className="min-w-0 space-y-6 wrap-anywhere">
      {/* 顶部标题区 */}
      <div className="rounded-2xl border border-accent/30 bg-gradient-to-br from-card to-accent-wash/30 p-6 shadow-card-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="h-[9px] w-[9px] rounded-[1px] bg-accent" />
              <h2 className="font-serif text-lg font-bold text-ink">经历深度挖掘档案</h2>
              {miningSummary.project_name && (
                <span className={badgePrimary}>{miningSummary.project_name}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              围绕已提供的背景、行动、取舍、结果与个人贡献整理经历，保留未知与待核实信息
            </p>
          </div>
          <span className={badgeAccent}>经历挖掘访谈产物</span>
        </div>

        {/* 经历全景 5 大板块 */}
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          {miningSummary.background && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>🎯 背景与任务 (Situation / Task)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.background}
              </p>
            </div>
          )}

          {miningSummary.actions && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>⚙️ 实际行动与方案 (Action)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.actions}
              </p>
            </div>
          )}

          {miningSummary.tradeoffs && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-accent">
                <span>⚖️ 取舍与决策依据 (Trade-offs & Decision)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.tradeoffs}
              </p>
            </div>
          )}

          {miningSummary.results && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>📈 已知结果与验证状态 (Result)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.results}
              </p>
            </div>
          )}

          {miningSummary.contribution && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs md:col-span-2">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>👤 个人分工与参与范围 (Personal Contribution)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.contribution}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 产物 1：待确认材料与信息清单 */}
      {miningSummary.pending_confirmations.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-card p-6 shadow-card-subtle space-y-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <div className="flex items-center gap-2">
              <span className="font-serif text-base font-bold text-ink">📋 待确认材料与信息清单</span>
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-bold text-amber-600">
                {miningSummary.pending_confirmations.length} 项需回溯核实
              </span>
            </div>
            <span className="text-xs text-muted">访谈中表述模糊或遗忘项，建议在写进简历前求证</span>
          </div>

          <div className="space-y-3">
            {miningSummary.pending_confirmations.map((item, index) => (
              <div
                key={index}
                className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 rounded-xl border border-line/80 bg-surface/40 p-3.5 transition-all hover:bg-surface"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-line px-1.5 py-0.5 text-[10px] font-mono text-muted">
                      {item.category || "待确认"}
                    </span>
                    <span className="text-xs font-bold text-ink">{item.item}</span>
                  </div>
                  {item.source_hint && (
                    <p className="text-xs text-muted font-sans pl-1">
                      💡 <strong>建议核查渠道：</strong>{item.source_hint}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 产物 2：精修简历描述草稿 */}
      {miningSummary.resume_bullets.length > 0 && (
        <section aria-label="简历描述草稿" className="rounded-2xl border border-primary/30 bg-card p-6 shadow-card-subtle space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <div>
              <h3 className="font-serif text-base font-bold text-ink flex items-center gap-2">
                <span>✍️ 简历描述草稿</span>
              </h3>
              <p className="mt-1 text-xs text-muted">
                基于已提供的访谈材料整理。使用前核对个人分工、事实与待补充内容；没有依据时不补写量化结果。
              </p>
            </div>
            <button
              type="button"
              className={btnPrimary}
              disabled={copying}
              onClick={() => { void copy(allBullets); }}
            >
              {copiedText === allBullets ? "✓ 全部草稿已复制" : "📋 一键复制全部要点"}
            </button>
          </div>
          {copyError?.text === allBullets && <p role="alert" className="text-xs text-danger">{copyError.message}</p>}

          <div className="space-y-2.5">
            {miningSummary.resume_bullets.map((bullet, index) => (
              <div
                key={index}
                className="group flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-surface/30 p-3.5 transition-all hover:border-primary/40 hover:bg-card"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span className="font-mono text-xs font-bold text-primary shrink-0 mt-0.5">
                    {index + 1}.
                  </span>
                  <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-ink leading-relaxed font-sans select-all">
                    {bullet}
                  </p>
                </div>
                <button
                  type="button"
                  className={`${btnGhost} text-xs py-1 px-2.5 shrink-0 opacity-80 group-hover:opacity-100`}
                  disabled={copying}
                  onClick={() => { void copy(bullet); }}
                >
                  {copiedText === bullet ? "已复制" : "复制"}
                </button>
                {copyError?.text === bullet && <p role="alert" className="basis-full text-xs text-danger">{copyError.message}</p>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
