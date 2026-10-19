"use client";

import { useState } from "react";
import type { MiningSummary } from "@/lib/scores";
import { badgeAccent, badgePrimary, btnGhost, btnPrimary } from "@/lib/ui";

export function MiningSummaryCard({ miningSummary }: { miningSummary: MiningSummary }) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopyAll = async () => {
    const text = miningSummary.resume_bullets.map((b) => `• ${b}`).join("\n");
    await navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const handleCopySingle = async (text: string, index: number) => {
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="space-y-6">
      {/* 顶部标题区 */}
      <div className="rounded-2xl border border-accent/30 bg-gradient-to-br from-card to-accent-wash/30 p-6 shadow-card-subtle">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-[9px] w-[9px] rounded-[1px] bg-accent" />
              <h2 className="font-serif text-lg font-bold text-ink">经历深度挖掘档案</h2>
              {miningSummary.project_name && (
                <span className={badgePrimary}>{miningSummary.project_name}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">
              围绕【背景 → 行动 → 取舍 → 结果 → 贡献】全流程提炼，把遗忘与模糊的经历重塑为结构化亮点
            </p>
          </div>
          <span className={badgeAccent}>经历挖掘访谈产物</span>
        </div>

        {/* 经历全景 5 大板块 */}
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          {miningSummary.background && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>🎯 背景与业务痛点 (Situation / Task)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.background}
              </p>
            </div>
          )}

          {miningSummary.actions && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>⚙️ 核心行动与技术方案 (Action)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.actions}
              </p>
            </div>
          )}

          {miningSummary.tradeoffs && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-accent">
                <span>⚖️ 关键取舍与架构决策 (Trade-offs & Decision)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.tradeoffs}
              </p>
            </div>
          )}

          {miningSummary.results && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>📈 量化成果与业务价值 (Result)</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap">
                {miningSummary.results}
              </p>
            </div>
          )}

          {miningSummary.contribution && (
            <div className="rounded-xl border border-line bg-card p-4 space-y-1.5 shadow-xs md:col-span-2">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>👤 个人核心贡献与担当角色 (Personal Contribution)</span>
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
        <div className="rounded-2xl border border-primary/30 bg-card p-6 shadow-card-subtle space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
            <div>
              <h3 className="font-serif text-base font-bold text-ink flex items-center gap-2">
                <span>✍️ 简历描述草稿（STAR + 量化结果）</span>
              </h3>
              <p className="mt-1 text-xs text-muted">
                基于本次访谈挖掘事实自动精修生成，建议确认无误后直接填入对应简历项目经历
              </p>
            </div>
            <button
              type="button"
              className={btnPrimary}
              onClick={handleCopyAll}
            >
              {copiedAll ? "✓ 全部草稿已复制" : "📋 一键复制全部要点"}
            </button>
          </div>

          <div className="space-y-2.5">
            {miningSummary.resume_bullets.map((bullet, index) => (
              <div
                key={index}
                className="group flex items-start justify-between gap-3 rounded-xl border border-line bg-surface/30 p-3.5 transition-all hover:border-primary/40 hover:bg-card"
              >
                <div className="flex items-start gap-2.5">
                  <span className="font-mono text-xs font-bold text-primary shrink-0 mt-0.5">
                    {index + 1}.
                  </span>
                  <p className="text-xs text-ink leading-relaxed font-sans select-all">
                    {bullet}
                  </p>
                </div>
                <button
                  type="button"
                  className={`${btnGhost} text-xs py-1 px-2.5 shrink-0 opacity-80 group-hover:opacity-100`}
                  onClick={() => handleCopySingle(bullet, index)}
                >
                  {copiedIndex === index ? "已复制" : "复制"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
