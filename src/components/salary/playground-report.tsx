"use client";

import type { NegotiationReport } from "@/lib/salary-negotiation";

interface SalaryPlaygroundReportProps {
  report: NegotiationReport;
  finalPackage?: string;
}

export function SalaryPlaygroundReport({
  report,
  finalPackage,
}: SalaryPlaygroundReportProps) {
  return (
    <div className="rounded-2xl border-2 border-accent/30 bg-card p-6 sm:p-8 shadow-card-float space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-accent/10 px-3 py-1 text-xs font-bold text-accent">
            <span>🏆 薪酬谈判终局复盘报告</span>
          </div>
          <h2 className="mt-2 font-serif text-2xl font-bold text-ink">
            最终锁定 Package：{finalPackage || report.final_package_summary}
          </h2>
        </div>

        {/* 评级徽章 */}
        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="block text-xs text-muted">综合博弈得分</span>
            <span className="font-mono text-2xl font-bold text-accent">
              {report.score} <span className="text-sm font-normal text-muted">/ 100</span>
            </span>
          </div>
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl border-2 border-accent bg-accent-wash shadow-inner">
            <span className="font-serif text-3xl font-black text-accent">
              {report.persuasion_grade}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 筹码转化效率 */}
        <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted">
            筹码转化与说服力评估
          </h3>
          <p className="text-sm leading-relaxed text-ink">
            {report.leverage_efficiency}
          </p>
        </div>

        {/* 军师寄语 */}
        <div className="rounded-xl border border-line bg-surface p-4 space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted">
            首席军师结语
          </h3>
          <p className="text-sm leading-relaxed text-ink">
            {report.mentor_summary}
          </p>
        </div>
      </div>

      {/* 关键回合得失时间轴 */}
      {report.turn_critiques.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-serif text-sm font-bold text-ink">
            关键对局胜负手时间轴
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {report.turn_critiques.map((c, i) => {
              const isGain = c.gain_or_loss === "gain";
              const isLoss = c.gain_or_loss === "loss";
              return (
                <div
                  key={i}
                  className={`rounded-xl border p-3.5 space-y-1 text-xs ${
                    isGain
                      ? "border-emerald-500/30 bg-emerald-500/5 text-ink"
                      : isLoss
                      ? "border-rose-500/30 bg-rose-500/5 text-ink"
                      : "border-line bg-surface text-ink"
                  }`}
                >
                  <div className="flex items-center justify-between font-medium">
                    <span>第 {c.turn_no} 回合</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        isGain
                          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-bold"
                          : isLoss
                          ? "bg-rose-500/20 text-rose-700 dark:text-rose-400 font-bold"
                          : "bg-line text-muted"
                      }`}
                    >
                      {isGain ? "优势得分" : isLoss ? "暴露破绽" : "平稳推进"}
                    </span>
                  </div>
                  <p className="font-semibold text-ink">{c.summary}</p>
                  <p className="text-muted leading-relaxed">{c.key_point}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 现实谈薪避坑锦囊 */}
      {report.real_world_tips.length > 0 && (
        <div className="space-y-2 rounded-xl border border-primary/20 bg-primary-soft/50 p-4">
          <h3 className="font-serif text-sm font-bold text-primary">
            现实谈薪避坑锦囊（实操提炼）
          </h3>
          <ul className="space-y-1.5 text-xs text-ink/90">
            {report.real_world_tips.map((tip, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="mt-1 flex h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
