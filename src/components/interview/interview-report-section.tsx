import { InterviewEvaluatorCard } from "@/components/interview/evaluator-card";
import { MiningSummaryCard } from "@/components/interview/mining-summary-card";
import type { InterviewData } from "@/hooks/use-interview-session";
import { interviewStyleOf } from "@/lib/interview";
import { INTERVIEW_DIMENSIONS, type EvaluatorReport } from "@/lib/scores";
import { seriesRoundOf } from "@/lib/series";
import { btnPrimary, scoreTextCls, textErr } from "@/lib/ui";

export type ReportTab = "candidate" | "evaluator" | "mining";

type InterviewReportSectionProps = {
  data: InterviewData;
  reportTab: ReportTab;
  setReportTab: (tab: ReportTab) => void;
  focusLabels: string[];
  remediating: boolean;
  remedialError: string;
  onStartRemediation: () => void;
  onEvaluatorReportGenerated: (report: EvaluatorReport) => void;
};

export function InterviewReportSection({
  data,
  reportTab,
  setReportTab,
  focusLabels,
  remediating,
  remedialError,
  onStartRemediation,
  onEvaluatorReportGenerated,
}: InterviewReportSectionProps) {
  const report = data.report;
  if (!report) return null;

  const styleName = data.series_id
    ? seriesRoundOf(data.round_no)?.label
    : interviewStyleOf(data.style).label;

  const hasMiningSummary = Boolean(report.mining_summary);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setReportTab("candidate")}
            className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
              reportTab === "candidate"
                ? "bg-primary text-on-primary shadow-xs"
                : "border border-line bg-card text-muted hover:text-ink"
            }`}
          >
            <span>📊 候选人全景复盘报告</span>
          </button>

          {(hasMiningSummary || data.style === "mining") && (
            <button
              type="button"
              onClick={() => setReportTab("mining")}
              className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
                reportTab === "mining"
                  ? "bg-accent text-on-primary shadow-xs"
                  : "border border-line bg-card text-muted hover:text-ink"
              }`}
            >
              <span>⛏️ 经历挖掘全景与产物</span>
              <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-bold">
                待确认&草稿
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setReportTab("evaluator")}
            className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-all ${
              reportTab === "evaluator"
                ? "bg-primary text-on-primary shadow-xs"
                : "border border-line bg-card text-muted hover:text-ink"
            }`}
          >
            <span>🕵️ 主考官内部录用评审表</span>
            <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold text-danger">
              {data.evaluator_report ? "呈报HR" : "未生成"}
            </span>
          </button>
        </div>

        {reportTab === "evaluator" && data.evaluator_report && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted font-serif">对标职级：</span>
            <span className="rounded-md border border-primary/30 bg-primary-soft px-2.5 py-0.5 font-mono font-bold text-primary">
              {data.evaluator_report.level}
            </span>
          </div>
        )}
      </div>

      {!data.evaluator_report && reportTab === "candidate" && (
        <p className="text-xs text-muted" role="status">
          面试官评估未生成。候选人复盘报告已保留，
          <button type="button" className="text-primary underline" onClick={() => setReportTab("evaluator")}>
            前往重试面试官评估
          </button>。
        </p>
      )}

      {reportTab === "candidate" && (
        <div className="space-y-5 rounded-2xl border border-primary/30 bg-card p-6 shadow-card-subtle">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
            <div>
              <h2 className="font-serif text-lg font-bold text-ink flex items-center gap-2">
                <span className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
                <span>本场面试全景评估结果</span>
              </h2>
              <p className="mt-1 text-xs text-muted">
                结合现场 4 轮追问深度、作答结构与真实项目经验综合评定
              </p>
            </div>
            <div className="text-right">
              <span className="text-xs text-muted">本场综合得分</span>
              <div className="font-mono text-4xl font-bold tabular-nums leading-none text-primary mt-1">
                {report.overall}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {INTERVIEW_DIMENSIONS.map((dimension) => (
              <div
                key={dimension.key}
                className="rounded-xl border border-line bg-surface/50 p-3 text-center transition-all hover:bg-surface"
              >
                <div className="text-xs text-muted">{dimension.label}</div>
                <div className={`mt-1 font-mono text-2xl font-bold tabular-nums ${scoreTextCls(report[dimension.key])}`}>
                  {report[dimension.key]}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div className="rounded-xl border border-primary/20 bg-primary-soft/30 p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-primary">
                <span>🌟 表现亮点</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans">{report.strengths}</p>
            </div>

            <div className="rounded-xl border border-danger/20 bg-danger-wash/40 p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-danger">
                <span>⚠️ 暴露短板</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans">{report.weaknesses}</p>
            </div>

            <div className="rounded-xl border border-accent/20 bg-accent-wash/40 p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 font-serif text-xs font-bold text-accent">
                <span>💡 改进建议</span>
              </div>
              <p className="text-xs text-ink/90 leading-relaxed font-sans">{report.suggestions}</p>
            </div>
          </div>

          {hasMiningSummary && (
            <div className="rounded-xl border border-accent/30 bg-accent-wash/30 p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="text-xs font-bold text-accent font-serif">⛏️ 经历挖掘专属产物已就绪：</span>
                <span className="text-xs text-muted ml-1">
                  已提炼背景/行动/取舍/结果全景、{report.mining_summary!.pending_confirmations.length} 项待确认材料、{report.mining_summary!.resume_bullets.length} 条精修简历草稿
                </span>
              </div>
              <button
                type="button"
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                onClick={() => setReportTab("mining")}
              >
                查看挖掘产物 →
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/60 pt-4">
            <div className="text-xs text-muted">
              <strong>追练建议重点：</strong>
              <span className="text-primary font-bold ml-1">{focusLabels.join("、") || "综合巩固"}</span>
              <span className="text-faint ml-2">（将围绕薄弱项一键出 5 道针对性专项考题）</span>
            </div>
            <button
              type="button"
              className={btnPrimary}
              onClick={onStartRemediation}
              disabled={remediating}
            >
              {remediating ? "出题中…" : "围绕短板一键生成追练题"}
            </button>
          </div>
          {remedialError && <p className={`mt-2 text-sm ${textErr}`}>{remedialError}</p>}
        </div>
      )}

      {reportTab === "mining" && (
        report.mining_summary ? (
          <MiningSummaryCard miningSummary={report.mining_summary} />
        ) : (
          <div className="rounded-2xl border border-dashed border-line bg-card p-8 text-center text-muted text-xs">
            本场面试尚未提取经历挖掘全景档案。
          </div>
        )
      )}

      {reportTab === "evaluator" && (
        <InterviewEvaluatorCard
          report={data.evaluator_report}
          interviewId={data.id}
          styleName={styleName}
          onReportGenerated={onEvaluatorReportGenerated}
        />
      )}
    </div>
  );
}
