"use client";

import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { SUMMARY_SECTIONS, type FiveDimensionSummaryKey, type ProjectSummary } from "@/lib/summary";
import { btnGhost, btnPrimary, inputCls, labelCls, textareaCls } from "@/lib/ui";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import type { SummaryStatus } from "./use-project-detail";
import type { SummaryProposal } from "./use-project-detail";
import type { SummaryUnitKey } from "@/lib/project-summary-diff";
import { ProjectSummaryReview } from "./project-summary-review";

type ProjectSummaryWorkbenchProps = {
  summaryDraft: ProjectSummary | null;
  pendingDraft: boolean;
  proposal?: SummaryProposal | null;
  selectedKeys?: SummaryUnitKey[];
  canConfirmDraft?: boolean;
  summarizing: boolean;
  savingSummary?: boolean;
  sumStatus: SummaryStatus | null;
  typewriter: { displayedText: string; isTyping: boolean };
  materialCount: number;
  onSummarize: (mode?: "full" | "resume-only") => void;
  onDiscardDraft: () => void;
  onSaveSummary: () => void;
  onChange: <K extends keyof ProjectSummary>(key: K, value: ProjectSummary[K]) => void;
  onUpdateAchievement?: (index: number, val: string) => void;
  onAddAchievement?: () => void;
  onRemoveAchievement?: (index: number) => void;
  onToggleAdoption?: (key: SummaryUnitKey) => void;
};

export function ProjectSummaryWorkbench({
  summaryDraft,
  pendingDraft,
  proposal,
  selectedKeys = [],
  canConfirmDraft = true,
  summarizing,
  savingSummary = false,
  sumStatus,
  typewriter,
  materialCount,
  onSummarize,
  onDiscardDraft,
  onSaveSummary,
  onChange,
  onUpdateAchievement,
  onAddAchievement,
  onRemoveAchievement,
  onToggleAdoption,
}: ProjectSummaryWorkbenchProps) {
  const { containerRef, handleScroll } = useAutoScroll(typewriter.displayedText);

  const achievements = summaryDraft?.achievements ?? [];

  return (
    <div className="space-y-5 lg:col-span-7">
      {sumStatus && (
        <div
          className={`rounded-xl border px-3 py-2 text-xs font-medium ${
            sumStatus.kind === "ok"
              ? "border-primary/30 bg-primary-soft text-primary"
              : sumStatus.kind === "err"
                ? "border-danger/30 bg-danger-wash text-danger"
                : sumStatus.kind === "warn"
                  ? "border-accent/30 bg-accent-wash text-accent"
                  : "border-line bg-surface text-muted"
          }`}
        >
          {sumStatus.text}
        </div>
      )}
      {pendingDraft && (
        <div className="flex flex-col gap-3 rounded-lg border border-accent/40 bg-accent-wash p-4 text-xs text-accent sm:flex-row sm:items-center sm:justify-between">
          <span>
            <strong>AI 草稿待确认：</strong>{proposal?.revisionId ? "请核对下方差异，当前档案在确认前保持原样。" : "下方提炼内容由 AI 根据最新材料生成，确认前尚未写入档案。"}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnGhost} onClick={onDiscardDraft}>
              放弃草稿
            </button>
            <button type="button" className={btnPrimary} onClick={onSaveSummary} disabled={!canConfirmDraft || savingSummary}>
              确认采用入库
            </button>
          </div>
        </div>
      )}
      {pendingDraft && proposal && onToggleAdoption && (
        <ProjectSummaryReview proposal={proposal} selectedKeys={selectedKeys} onToggleAdoption={onToggleAdoption} />
      )}
      {summarizing && (
        <div className="rounded-2xl border border-primary/30 bg-primary-soft/40 p-5 shadow-card-subtle animate-in fade-in duration-200">
          <div className="flex items-center gap-2 text-xs font-bold text-primary">
            <span className="inline-block h-2 w-2 animate-ping rounded-full bg-primary" />
            AI 架构师正在深入分析材料，构思五维 STAR 提炼与简历三要素…
          </div>
          <div
            ref={containerRef}
            onScroll={handleScroll}
            className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl bg-card p-4 font-sans text-xs sm:text-sm text-ink leading-relaxed border border-line"
          >
            {typewriter.displayedText || "正在分析业务挑战背景与技术选型行动…"}
            {typewriter.isTyping && (
              <span className="inline-block h-4 w-1.5 ml-0.5 bg-primary animate-pulse align-middle" />
            )}
          </div>
        </div>
      )}

      {/* 简历专供精炼素材面板（技术栈 + 项目简要概述 + 成果清单） */}
      <fieldset disabled={savingSummary} className="relative space-y-5 rounded-2xl border border-primary/25 bg-primary-soft/10 p-6 shadow-card-subtle">
        <LoadingOverlay
          show={savingSummary}
          message="正在保存并写入项目档案…"
          description="正在持久化更新项目档案，请稍候…"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/15 pb-3.5">
          <div className="flex items-center gap-2">
            <span className="h-[9px] w-[9px] rounded-full bg-primary" />
            <h2 className="font-serif text-base font-bold text-ink">
              📄 简历专供素材（技术栈 · 简述 · 核心成果）
            </h2>
            <span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary border border-primary/20">
              用于简历一键摘取
            </span>
          </div>
          {summaryDraft && (
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
              onClick={() => onSummarize("resume-only")}
              disabled={summarizing || savingSummary || materialCount === 0}
            >
              ✨ 单独提炼简历三项
            </button>
          )}
        </div>

        {summaryDraft ? (
          <div className="space-y-4">
            <div>
              <label htmlFor="resume-tech-stack" className={labelCls}>
                技术栈（核心语言、框架、主要依赖）
              </label>
              <input
                id="resume-tech-stack"
                className={`${inputCls} mt-1`}
                value={summaryDraft.techStack || ""}
                onChange={(e) => onChange("techStack", e.target.value)}
                placeholder="例如：React 19, Next.js, TypeScript, Tailwind CSS, SQLite"
              />
            </div>

            <div>
              <label htmlFor="resume-brief" className={labelCls}>
                项目简要概述（针对简历的一两句精炼介绍）
              </label>
              <textarea
                id="resume-brief"
                rows={2}
                className={`${textareaCls} mt-1 font-sans text-xs sm:text-sm bg-card`}
                value={summaryDraft.brief || ""}
                onChange={(e) => onChange("brief", e.target.value)}
                placeholder="简明扼要说明项目定位与解决的核心痛点..."
              />
            </div>

            <div>
              <div className="flex items-center justify-between">
                <span className={labelCls}>项目描述与成果（每一项单独列出）</span>
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => onAddAchievement ? onAddAchievement() : onChange("achievements", [...achievements, ""])}
                >
                  + 添加一项成果
                </button>
              </div>

              {achievements.length === 0 ? (
                <p className="mt-2 text-xs text-muted">暂无成果条目，点击上方「+ 添加一项成果」或点击重新提炼生成。</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {achievements.map((item, index) => (
                    <div key={index} className="flex items-start gap-2">
                      <span className="mt-2 font-mono text-xs font-bold text-primary shrink-0">
                        {index + 1}.
                      </span>
                      <textarea
                        aria-label={`项目成果${index + 1}`}
                        rows={2}
                        className={`${textareaCls} flex-1 font-sans text-xs sm:text-sm bg-card`}
                        value={item}
                        onChange={(e) => {
                          if (onUpdateAchievement) {
                            onUpdateAchievement(index, e.target.value);
                          } else {
                            const next = [...achievements];
                            next[index] = e.target.value;
                            onChange("achievements", next);
                          }
                        }}
                        placeholder={`成果 ${index + 1}：具体的工程动作、技术决策与量化业务/技术成效...`}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (onRemoveAchievement) {
                            onRemoveAchievement(index);
                          } else {
                            onChange("achievements", achievements.filter((_, i) => i !== index));
                          }
                        }}
                        className="mt-2 text-xs text-muted hover:text-danger p-1 rounded transition-colors"
                        title="删除该项"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted">生成总结后将在此展示技术栈、简述与核心成果清单。</p>
        )}
      </fieldset>

      {/* 原有五维 STAR 结构化亮点提炼面板（完整保留） */}
      <fieldset disabled={savingSummary} className="relative space-y-5 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
        <LoadingOverlay
          show={savingSummary}
          message="正在保存并写入项目档案…"
          description="正在持久化更新项目档案，请稍候…"
        />
        <div className="flex items-center justify-between border-b border-line pb-3.5">
          <div className="flex items-center gap-2">
            <span className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <h2 className="font-serif text-base font-bold text-ink">STAR 结构化亮点提炼面板（深度面试备战）</h2>
          </div>
          {summaryDraft && (
            <button type="button" className={btnGhost} onClick={onSaveSummary} disabled={savingSummary || (pendingDraft && !canConfirmDraft)}>
              {pendingDraft ? "确认采用草稿" : "保存修改"}
            </button>
          )}
        </div>
        {summaryDraft ? (
          <div className="space-y-4">
            {SUMMARY_SECTIONS.map((section) => {
              const isHighlight = section.key === "architecture" || section.key === "highlights";
              return (
                <div
                  key={section.key}
                  className={`space-y-2 rounded-xl border p-4 transition-all ${
                    isHighlight
                      ? "border-primary/30 bg-primary-soft/30 hover:border-primary/50"
                      : "border-line bg-surface/30 hover:border-line-strong hover:bg-surface/50"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor={`project-summary-${section.key}`}
                      className="flex items-center gap-2 text-xs font-bold text-ink cursor-pointer"
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-5 w-5 items-center justify-center rounded font-mono text-[10px] font-bold ${
                          isHighlight
                            ? "bg-primary text-white"
                            : "bg-surface-2 text-muted border border-line"
                        }`}
                      >
                        {section.key.charAt(0).toUpperCase()}
                      </span>
                      <span>{section.label}</span>
                    </label>
                    {isHighlight && (
                      <span className="rounded bg-primary-soft px-2 py-0.5 text-[10px] font-bold text-primary border border-primary/20">
                        核心攻坚 · 面试必问
                      </span>
                    )}
                  </div>
                  <textarea
                    id={`project-summary-${section.key}`}
                    className={`${textareaCls} font-sans text-xs sm:text-sm bg-card`}
                    value={summaryDraft[section.key as FiveDimensionSummaryKey] || ""}
                    onChange={(event) => onChange(section.key as FiveDimensionSummaryKey, event.target.value)}
                    placeholder={`编写或由 AI 提炼关于「${section.label}」的内容…`}
                  />
                </div>
              );
            })}
            <div className="flex items-center justify-end gap-2 pt-2">
              {pendingDraft && (
                <button type="button" className={btnGhost} onClick={onDiscardDraft}>
                  放弃本次草稿
                </button>
              )}
              <button type="button" className={btnPrimary} onClick={onSaveSummary} disabled={savingSummary || (pendingDraft && !canConfirmDraft)}>
                {pendingDraft ? "确认采用并写入档案" : "保存总结修改"}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line-strong bg-surface/30 p-8 text-center space-y-3">
            <p className="text-xs text-muted leading-relaxed">
              暂未生成 AI 结构化亮点总结。请在右侧录入架构设计或复盘文档后，点击顶部「生成 AI STAR 总结」。
            </p>
            <button
              type="button"
              className={btnPrimary}
              onClick={() => onSummarize("full")}
              disabled={summarizing || savingSummary || materialCount === 0}
            >
              {materialCount === 0 ? "请先添加材料" : "立即提炼五维亮点与简历三要素"}
            </button>
          </div>
        )}
      </fieldset>
    </div>
  );
}
