"use client";

import { useState } from "react";
import { normalizeEvaluatorReport, type EvaluatorReport, type EvaluatorRecommendation } from "@/lib/scores";
import { badgeCls, cardCls, wellCls, btnPrimary, textErr } from "@/lib/ui";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";

interface InterviewEvaluatorCardProps {
  report: EvaluatorReport | null;
  interviewId: number;
  styleName?: string;
  onReportGenerated?: (newReport: EvaluatorReport) => void;
}

export function InterviewEvaluatorCard({
  report,
  interviewId,
  styleName,
  onReportGenerated,
}: InterviewEvaluatorCardProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    try {
      const data = await jsonFetch<{ evaluator_report?: unknown }>(
        `/api/interviews/${interviewId}/evaluator-report`,
        { method: "POST" }
      );
      const generated = normalizeEvaluatorReport(data.evaluator_report);
      if (!generated) throw new Error("面试官评估未生成，请重试");
      onReportGenerated?.(generated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  // 渲染录用建议印章
  function renderRecommendationBadge(rec: EvaluatorRecommendation) {
    switch (rec) {
      case "Strong Hire":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-primary/40 bg-primary-soft/80 px-3 py-1 font-mono text-sm font-bold tracking-wider text-primary shadow-sm">
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            STRONG HIRE · 极力推荐
          </span>
        );
      case "Hire":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-primary/30 bg-primary-soft/50 px-3 py-1 font-mono text-sm font-bold tracking-wider text-primary">
            <span className="h-2 w-2 rounded-full bg-primary" />
            HIRE · 建议录用
          </span>
        );
      case "Lean No":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-accent/40 bg-accent-wash px-3 py-1 font-mono text-sm font-bold tracking-wider text-accent">
            <span className="h-2 w-2 rounded-full bg-accent" />
            LEAN NO · 慎重/看备选
          </span>
        );
      case "No Hire":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-danger/40 bg-danger-wash px-3 py-1 font-mono text-sm font-bold tracking-wider text-danger">
            <span className="h-2 w-2 rounded-full bg-danger" />
            NO HIRE · 不予录用
          </span>
        );
      default:
        return <span className={badgeCls}>{rec}</span>;
    }
  }

  if (!report) {
    return (
      <div className={`relative ${cardCls} p-6 text-center space-y-4`}>
        <LoadingOverlay
          show={generating}
          message="正在生成面试官内部录用评估报表…"
          description="正在从面试官视角深度分析录用结论（Strong Hire / Hire / No Hire）、定级依据与潜在风险，请稍候…"
        />
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-2xl">
          📑
        </div>
        <div>
          <h3 className="text-base font-semibold text-ink">面试官评估未生成</h3>
          <p className="mt-1 text-xs text-muted max-w-md mx-auto">
            候选人复盘报告已保留，可单独重试生成面试官的录用建议、定级依据和风险评估。
          </p>
        </div>
        {error && <p className={`text-xs ${textErr}`}>{error}</p>}
        <div>
          <button className={btnPrimary} onClick={handleGenerate} disabled={generating}>
            {generating ? "面试官评估生成中…" : "重试生成面试官评估"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${cardCls} overflow-hidden border-line shadow-card-subtle transition-all`}>
      {/* 头部：机密标记 + 面试官信息 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-danger/10 px-2 py-0.5 font-mono text-[11px] font-bold tracking-widest text-danger">
            CONFIDENTIAL
          </span>
          <span className="font-semibold text-sm text-ink">
            面试官录用评估与定级报表（呈报 HR 内部草稿）
          </span>
          {styleName && <span className={badgeCls}>{styleName}视角</span>}
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* 核心结论看板：录用建议 + 职级对标 */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 rounded-xl border border-line bg-bg p-4.5">
          {/* 左侧：录用建议 */}
          <div className="md:col-span-5 flex flex-col justify-center border-b md:border-b-0 md:border-r border-line pb-4 md:pb-0 md:pr-4">
            <span className="text-xs font-medium text-muted">录用结论（Recommendation）</span>
            <div className="mt-2.5">{renderRecommendationBadge(report.recommendation)}</div>
            <p className="mt-2 text-[11px] text-faint">
              * 基于全场问答技术深度、架构视野与团队匹配综合判定
            </p>
          </div>

          {/* 右侧：职级对标 */}
          <div className="md:col-span-7 flex flex-col justify-center md:pl-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">建议定级（阿里 P 级对标）</span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary font-mono">
                Alibaba Leveling
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tracking-tight text-ink">
                {report.level}
              </span>
            </div>
            {report.level_justification && (
              <p className="mt-2 text-xs leading-relaxed text-muted">
                <span className="font-medium text-ink">定级依据：</span>
                {report.level_justification}
              </p>
            )}
          </div>
        </div>

        {/* 呈报 HR 执行摘要 */}
        {report.summary_for_hr && (
          <div className={`${wellCls} space-y-1.5`}>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <span>📌 呈报 HR 核心定调与摘要</span>
            </div>
            <p className="text-xs leading-relaxed text-muted whitespace-pre-wrap">
              {report.summary_for_hr}
            </p>
          </div>
        )}

        {/* 录用理由 vs 潜在顾虑 双栏 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 录用理由 */}
          <div className="rounded-xl border border-line bg-card p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-soft text-xs text-primary font-bold">
                ✓
              </span>
              <span className="text-xs font-semibold text-ink">建议录用理由（Why Hire）</span>
            </div>
            {report.hire_reasons.length > 0 ? (
              <ul className="space-y-1.5 text-xs text-muted">
                {report.hire_reasons.map((reason, idx) => (
                  <li key={idx} className="flex items-start gap-1.5 leading-relaxed">
                    <span className="text-primary mt-0.5">•</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">暂无明显亮点记录</p>
            )}
          </div>

          {/* 潜在顾虑 / Red Flags */}
          <div className="rounded-xl border border-line bg-card p-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-danger-wash text-xs text-danger font-bold">
                !
              </span>
              <span className="text-xs font-semibold text-ink">潜在风险与顾虑（Concerns & Risks）</span>
            </div>
            {report.concerns_and_risks.length > 0 ? (
              <ul className="space-y-1.5 text-xs text-muted">
                {report.concerns_and_risks.map((concern, idx) => (
                  <li key={idx} className="flex items-start gap-1.5 leading-relaxed">
                    <span className="text-danger mt-0.5">•</span>
                    <span>{concern}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">未发现明显硬伤或风险点</p>
            )}
          </div>
        </div>

        {/* 团队定岗与试用期建议 */}
        {report.placement_suggestion && (
          <div className="rounded-xl border border-line bg-card p-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs">🎯</span>
              <span className="text-xs font-semibold text-ink">定岗建议与试用期考核侧重</span>
            </div>
            <p className="text-xs leading-relaxed text-muted whitespace-pre-wrap">
              {report.placement_suggestion}
            </p>
          </div>
        )}

        {/* 现场关键问答实录佐证 */}
        {report.evidence_quotes && report.evidence_quotes.length > 0 && (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink">🔍 面试现场问答佐证与切片观察</span>
              <span className="text-[11px] text-faint">面试官现场记录</span>
            </div>
            <div className="space-y-2">
              {report.evidence_quotes.map((eq, idx) => (
                <div key={idx} className="rounded-lg border border-line/80 bg-surface p-3 text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted">
                      Q{eq.turn_idx}
                    </span>
                    <span className="font-medium text-ink">{eq.topic}</span>
                  </div>
                  <p className="text-muted leading-relaxed pl-1">{eq.observation}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
