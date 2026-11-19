"use client";

import { type EvaluatorReport, type EvaluatorRecommendation } from "@/lib/scores";
import { badgeCls, cardCls, wellCls, btnPrimary, textErr } from "@/lib/ui";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { useInterviewEvaluator } from "@/hooks/use-interview-evaluator";

interface InterviewEvaluatorCardProps {
  report: EvaluatorReport | null;
  interviewId: number;
  styleName?: string;
  onReportGenerated?: (newReport: EvaluatorReport) => void;
}

export function InterviewEvaluatorCard({
  report: initialReport,
  interviewId,
  styleName,
  onReportGenerated,
}: InterviewEvaluatorCardProps) {
  const { report, generating, error, readRecovery, generate, retryRead } = useInterviewEvaluator({
    interviewId, report: initialReport, onReportGenerated,
  });

  // 展示模拟建议，保留既有协议枚举。
  function renderRecommendationBadge(rec: EvaluatorRecommendation) {
    switch (rec) {
      case "Strong Hire":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-primary/40 bg-primary-soft/80 px-3 py-1 font-mono text-sm font-bold tracking-wider text-primary shadow-sm">
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            STRONG HIRE · 模拟积极推荐
          </span>
        );
      case "Hire":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-primary/30 bg-primary-soft/50 px-3 py-1 font-mono text-sm font-bold tracking-wider text-primary">
            <span className="h-2 w-2 rounded-full bg-primary" />
            HIRE · 模拟推荐
          </span>
        );
      case "Lean No":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-accent/40 bg-accent-wash px-3 py-1 font-mono text-sm font-bold tracking-wider text-accent">
            <span className="h-2 w-2 rounded-full bg-accent" />
            LEAN NO · 模拟审慎建议
          </span>
        );
      case "No Hire":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-danger/40 bg-danger-wash px-3 py-1 font-mono text-sm font-bold tracking-wider text-danger">
            <span className="h-2 w-2 rounded-full bg-danger" />
            NO HIRE · 模拟暂不推荐
          </span>
        );
      default:
        return <span className={badgeCls}>{rec}</span>;
    }
  }

  if (!report) {
    return (
      <div className={`relative ${cardCls} min-w-0 wrap-anywhere p-6 text-center space-y-4`}>
        <LoadingOverlay
          show={generating}
          message={readRecovery ? "正在读取面试官评估状态…" : "正在生成面试官模拟评估…"}
          description={readRecovery ? "正在核对已保存结果，请稍候…" : "正在整理本次回答中的表现、职级参考与待核实信息，请稍候…"}
        />
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-2xl">
          📑
        </div>
        <div>
          <h3 className="text-base font-semibold text-ink">{readRecovery ? "面试官评估状态待确认" : "面试官评估未生成"}</h3>
          <p className="mt-1 text-xs text-muted max-w-md mx-auto">
            {readRecovery ? "候选人复盘报告已保留，请先重新读取评估状态，确认结果是否已保存。" : "候选人复盘报告已保留，可单独重试模拟评估。"}
            建议仅供练习参考，不代表真实公司的录用或定级结论。
          </p>
        </div>
        {error && <p role="alert" className={`text-xs ${textErr}`}>{error}</p>}
        <div>
          <button type="button" className={btnPrimary} onClick={readRecovery ? retryRead : generate} disabled={generating}>
            {readRecovery ? (generating ? "评估状态读取中…" : "重新读取面试官评估") : (generating ? "面试官评估生成中…" : "重试生成面试官评估")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${cardCls} min-w-0 wrap-anywhere overflow-hidden border-line shadow-card-subtle transition-all`}>
      {/* 模拟评估标记与视角 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded bg-danger/10 px-2 py-0.5 font-mono text-[11px] font-bold tracking-widest text-danger">
            模拟练习
          </span>
          <span className="font-semibold text-sm text-ink">
            面试官模拟评估与职级参考
          </span>
          {styleName && <span className={badgeCls}>{styleName}视角</span>}
        </div>
      </div>

      <div className="p-5 space-y-5">
        <p className="text-xs leading-relaxed text-muted">本报告用于模拟面试复盘，不代表真实公司的录用决定或官方职级认定。</p>
        {/* 核心结论看板：录用建议 + 职级对标 */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 rounded-xl border border-line bg-bg p-4.5">
          {/* 左侧：录用建议 */}
          <div className="md:col-span-5 min-w-0 flex flex-col justify-center border-b md:border-b-0 md:border-r border-line pb-4 md:pb-0 md:pr-4">
            <span className="text-xs font-medium text-muted">模拟建议（Recommendation）</span>
            <div className="mt-2.5">{renderRecommendationBadge(report.recommendation)}</div>
            <p className="mt-2 text-[11px] text-faint">
              仅依据本次回答与提供的材料；未考察不代表不会，不能据此核验经历真伪。
            </p>
          </div>

          {/* 右侧：职级对标 */}
          <div className="md:col-span-7 min-w-0 flex flex-col justify-center md:pl-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted">职级参考（非公司官方定级）</span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary font-mono">
                练习参考
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tracking-tight text-ink">
                {report.level}
              </span>
            </div>
            {report.level_justification && (
              <p className="mt-2 text-xs leading-relaxed text-muted">
                <span className="font-medium text-ink">参考依据与局限：</span>
                {report.level_justification}
              </p>
            )}
          </div>
        </div>

        {/* 模拟评估摘要 */}
        {report.summary_for_hr && (
          <div className={`${wellCls} space-y-1.5`}>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <span>📌 模拟评估摘要</span>
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
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-soft text-xs text-primary font-bold">
                ✓
              </span>
              <span className="text-xs font-semibold text-ink">回答中的积极表现</span>
            </div>
            {report.hire_reasons.length > 0 ? (
              <ul className="space-y-1.5 text-xs text-muted">
                {report.hire_reasons.map((reason, idx) => (
                  <li key={idx} className="flex items-start gap-1.5 leading-relaxed">
                    <span className="text-primary mt-0.5">•</span>
                    <span className="min-w-0">{reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">本报告未提供具体积极表现记录</p>
            )}
          </div>

          {/* 潜在顾虑 / Red Flags */}
          <div className="rounded-xl border border-line bg-card p-4 space-y-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
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
                    <span className="min-w-0">{concern}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">本报告未提供具体风险观察，仍需进一步考察</p>
            )}
          </div>
        </div>

        {/* 团队定岗与试用期建议 */}
        {report.placement_suggestion && (
          <div className="rounded-xl border border-line bg-card p-4 space-y-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="text-xs">🎯</span>
              <span className="text-xs font-semibold text-ink">后续考察与练习建议</span>
            </div>
            <p className="text-xs leading-relaxed text-muted whitespace-pre-wrap">
              {report.placement_suggestion}
            </p>
          </div>
        )}

        {/* 回答依据摘要：不是逐字引文 */}
        {report.evidence_quotes && report.evidence_quotes.length > 0 && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink">🔍 回答依据摘要</span>
              <span className="text-[11px] text-faint">根据本次回答整理 · 非逐字引文</span>
            </div>
            <div className="space-y-2">
              {report.evidence_quotes.map((eq, idx) => (
                <div key={idx} className="rounded-lg border border-line/80 bg-surface p-3 text-xs space-y-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
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
