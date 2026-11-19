"use client";

import Link from "next/link";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import { useParams } from "next/navigation";
import { INTERVIEW_DIMENSIONS } from "@/lib/scores";
import { SERIES_ROUND_DEFS, seriesRoundOf } from "@/lib/series";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { btnPrimary, scoreTextCls, textErr } from "@/lib/ui";
import { usePreparationHref } from "@/hooks/use-preparation-href";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";
import { useInterviewSeries } from "@/hooks/use-interview-series";

export default function SeriesPage() {
  const params = useParams<{ id: string }>();
  const preparationHref = usePreparationHref();
  const { data, loadError, retryLoad, actionError, advancing, finalizing, readRecovery, retryRead, advance, finalize } = useInterviewSeries(params.id);

  if (loadError) return <LoadError message={loadError} onRetry={retryLoad} />;
  if (!data) return <Loading />;

  const entryFor = (no: number) => data.entries.find((e) => e.round_no === no);
  const ongoing = data.entries.find((e) => e.status === "ongoing");
  const last = data.entries[data.entries.length - 1];
  const nextDef = last ? seriesRoundOf(last.round_no + 1) : undefined;
  // 可进入下一轮：最后一轮已出报告且还有未建的轮次
  const canAdvance = data.status === "ongoing" && !data.final_report && last?.status === "finished" && last.report && nextDef;
  // 可生成总评：三轮齐备且各自报告已出
  const canFinalize = !data.final_report && data.entries.length === data.rounds_total && data.entries.every((e) => e.status === "finished" && e.report);
  // 三轮已答完但有轮次缺报告：提示先回该轮生成报告
  const missingReport = [...data.entries]
    .filter((e) => e.status === "finished" && !e.report)
    .map((e) => seriesRoundOf(e.round_no)?.label ?? `第${e.round_no}面`);

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 wrap-anywhere">
      <PreparationReturnLink />
      {/* 头部导航与状态栏 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Link
              href="/interviews"
              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              ← 返回模拟面试大厅
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="text-xs text-muted font-mono">进阶三轮连打 #{data.id}</span>
          </div>
          <h1 className="mt-1 font-serif text-2xl sm:text-3xl font-bold text-ink flex flex-wrap items-center gap-3">
            <span>进阶多轮模拟面试</span>
            <span className="font-sans text-sm font-normal text-muted bg-surface border border-line px-2.5 py-0.5 rounded-full">
              关联简历：{data.resume_title}
              <ResumeVersionBadge {...data} />
            </span>
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            一面技术深挖 → 二面方案权衡 → 三面 HR 综合。各轮反馈作为后续模拟出题的参考，三轮报告齐备后可生成跨轮总评。
          </p>
        </div>

        <div className="flex flex-col items-end gap-1 text-xs">
          <span className={`inline-flex rounded-full px-2.5 py-0.5 font-medium border ${
            data.status === "finished"
              ? "border-accent/30 bg-accent-wash text-accent font-bold"
              : "border-primary/25 bg-primary-soft text-primary"
          }`}>
            {data.final_report ? "● 模拟练习完成 / 已出跨轮总评" : data.status === "finished" ? "● 跨轮总评待补全" : "● 三轮模拟练习进行中"}
          </span>
          <span className="font-mono text-[11px] text-faint">
            创建于 {new Date(data.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* 岗位 JD 折叠卡片 */}
      <details className="group rounded-2xl border border-line bg-card p-4 shadow-card-subtle">
        <summary className="cursor-pointer text-xs font-medium text-muted transition-colors hover:text-ink flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span>目标岗位 JD 描述</span>
          </span>
          <span className="text-faint text-[11px] group-open:rotate-180 transition-transform">▼</span>
        </summary>
        <p className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface/70 border border-line/60 p-4 font-mono text-xs text-muted leading-relaxed">
          {data.jd}
        </p>
      </details>

      {/* 三轮进阶关卡卡片网格 */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
          <h2 className="font-serif text-base font-bold text-ink">三轮递进考场阶段</h2>
        </div>

        <ol className="grid gap-4 sm:grid-cols-3">
          {SERIES_ROUND_DEFS.map((def) => {
            const entry = entryFor(def.no);
            const isOngoing = entry?.status === "ongoing";
            const isFinished = entry?.status === "finished";
            const body = (
              <div className="space-y-3 flex flex-col justify-between h-full">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-bold text-primary bg-primary-soft px-2 py-0.5 rounded">
                      ROUND 0{def.no}
                    </span>
                    {entry?.report ? (
                      <span className="rounded-full border border-primary/25 bg-primary-soft px-2 py-0.2 font-mono text-[10px] font-bold text-primary">
                        已出报告
                      </span>
                    ) : isOngoing ? (
                      <span className="rounded-full border border-accent/25 bg-accent-wash px-2 py-0.2 font-mono text-[10px] font-bold text-accent animate-pulse">
                        进行中
                      </span>
                    ) : (
                      <span className="rounded-full border border-line bg-surface px-2 py-0.2 font-mono text-[10px] text-faint">
                        待开启
                      </span>
                    )}
                  </div>
                  <h3 className="font-serif text-[16px] font-bold leading-snug text-ink">{def.label}</h3>
                  <p className="text-xs text-muted leading-relaxed">{def.desc}</p>
                </div>

                <div className="border-t border-line/60 pt-3">
                  {!entry ? (
                    <p className="text-xs text-faint">上一轮报告生成后开启</p>
                  ) : entry.report ? (
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-muted">本面总分</span>
                      <span className={`font-mono text-2xl font-bold tabular-nums ${scoreTextCls(entry.report.overall)}`}>
                        {entry.report.overall} <span className="text-xs font-normal text-faint font-sans">/ 10</span>
                      </span>
                    </div>
                  ) : isOngoing ? (
                    <p className="text-xs text-accent font-medium">
                      正在进行 · 已答 <span className="font-mono font-bold">{entry.answered}/{entry.rounds}</span> 题
                    </p>
                  ) : (
                    <p className="text-xs text-faint">已答完 · 待生成报告</p>
                  )}
                </div>
              </div>
            );
            return (
              <li
                key={def.no}
                className={`rounded-2xl border p-5 shadow-card-subtle transition-all duration-200 ${
                  isOngoing
                    ? "border-accent bg-accent-wash/30 ring-2 ring-accent/15"
                    : isFinished
                    ? "border-primary/40 bg-card hover:border-primary/60"
                    : "border-line bg-card/60 opacity-80"
                }`}
              >
                {entry ? (
                  <Link
                    href={preparationHref(`/interviews/${entry.interview_id}`)}
                    className="block h-full group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    {body}
                  </Link>
                ) : (
                  body
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* 流程推进控制器 */}
      {(readRecovery || ongoing || canAdvance || canFinalize || missingReport.length > 0) && !data.final_report && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary/30 bg-primary-soft/30 p-5 shadow-card-subtle">
          <div className="min-w-0 space-y-1">
            {readRecovery ? (
              <>
                <p className="text-sm font-bold text-ink">{readRecovery.kind === "finalize" ? "跨轮总评状态待确认" : "下一轮创建状态待确认"}</p>
                <p className="text-xs text-muted">请先重新读取系列状态，确认结果是否已保存。</p>
              </>
            ) : ongoing ? (
              <>
                <p className="text-sm font-bold text-ink flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-accent animate-ping" />
                  <span>{seriesRoundOf(ongoing.round_no)?.label} 正在进行中</span>
                </p>
                <p className="text-xs text-muted">点击右侧按钮继续作答；完成本轮所有题目后即可结算本面报告。</p>
              </>
            ) : canAdvance && nextDef ? (
              <>
                <p className="text-sm font-bold text-ink">上一轮报告已评定，{nextDef.label}已就绪！</p>
                <p className="text-xs text-muted">{nextDef.desc} · 前序轮次的答辩弱项将带入该考场。</p>
              </>
            ) : canFinalize ? (
              <>
                <p className="text-sm font-bold text-ink">🎉 三轮考场报告已全部齐备！</p>
                <p className="text-xs text-muted">汇总各轮报告中明确记载的表现、待核实事项与练习建议；分数差异不代表能力进步或退步。</p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold text-danger">⚠️ 尚有轮次未生成单轮报告</p>
                <p className="text-xs text-muted">{missingReport.join("、")}已答完，请先点击对应卡片生成单轮报告后再推进。</p>
              </>
            )}
          </div>

          <div className="shrink-0">
            {readRecovery ? (
              <button type="button" className={btnPrimary} onClick={retryRead} disabled={advancing || finalizing}>
                {advancing || finalizing ? "正在核对系列状态…" : "重新读取系列状态"}
              </button>
            ) : ongoing ? (
              <Link href={preparationHref(`/interviews/${ongoing.interview_id}`)} className={btnPrimary}>
                继续本轮答题 →
              </Link>
            ) : canAdvance ? (
              <button type="button" className={btnPrimary} onClick={advance} disabled={advancing || finalizing}>
                {advancing ? "面试官命题中…" : `进入 ${nextDef!.label} →`}
              </button>
            ) : canFinalize ? (
              <button type="button" className={btnPrimary} onClick={finalize} disabled={advancing || finalizing}>
                {finalizing ? "正在合成总评中…" : "一键生成跨轮总评 🏆"}
              </button>
            ) : null}
          </div>
        </div>
      )}
      {actionError && <p role="alert" className={`text-sm ${textErr}`}>{actionError}</p>}

      {/* 跨轮总评报告展示 */}
      {data.final_report && (
        <div className="rounded-2xl border border-primary/30 bg-card p-6 sm:p-7 shadow-card-subtle space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-soft text-primary font-bold text-base">
                🏆
              </span>
              <div>
                <h2 className="font-serif text-xl font-bold text-ink">三轮连打 · 跨轮综合总评</h2>
                <p className="text-xs text-muted">依据三轮报告及其中的模型观察整理，仅供模拟复盘，不代表真实录用结果。</p>
              </div>
            </div>

            <div className="flex items-baseline gap-2 bg-primary-soft/50 border border-primary/20 rounded-xl px-4 py-2">
              <span className="text-xs text-muted">三轮综合均分:</span>
              <span className="font-mono text-3xl font-extrabold text-primary tabular-nums">
                {data.final_report.overall}
              </span>
              <span className="text-xs font-normal text-faint">/ 10</span>
            </div>
          </div>

          {/* 各轮小分汇总表 */}
          <div className="space-y-2">
            <h3 className="text-xs font-serif font-bold text-ink">各轮次评分细项对比</h3>
            <p className="text-xs text-muted">各轮题目和侧重点不同，分数不宜直接比较；“真实性”分仅供材料一致性反馈，不代表事实核验。</p>
            <div className="space-y-2">
              {data.entries.map((e) => {
                const label = seriesRoundOf(e.round_no)?.label ?? `第${e.round_no}面`;
                return (
                  <div
                    key={e.interview_id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface/40 p-3.5 text-xs"
                  >
                    <span className="font-serif font-bold text-ink w-28 shrink-0">{label}</span>
                    {e.report ? (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 flex-1">
                        {INTERVIEW_DIMENSIONS.map((d) => (
                          <span key={d.key} className="text-muted">
                            {d.label}:{" "}
                            <span className={`font-mono font-bold tabular-nums ${scoreTextCls(e.report![d.key])}`}>
                              {e.report![d.key]}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-faint">报告未生成</span>
                    )}

                    {e.report && (
                      <span className="font-mono text-sm font-bold text-primary tabular-nums shrink-0">
                        均分 {e.report.overall}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 综合分析结论卡片 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="rounded-xl border border-line bg-surface/30 p-4 space-y-1.5">
              <span className="font-bold text-primary block">🎯 综合总评结论</span>
              <p className="text-ink leading-relaxed font-sans whitespace-pre-wrap">{data.final_report.verdict}</p>
            </div>
            <div className="rounded-xl border border-primary/20 bg-primary-soft/30 p-4 space-y-1.5">
              <span className="font-bold text-primary block">💪 跨轮展现强项</span>
              <p className="text-ink leading-relaxed font-sans whitespace-pre-wrap">{data.final_report.strengths}</p>
            </div>
            <div className="rounded-xl border border-danger/20 bg-danger-wash/40 p-4 space-y-1.5">
              <span className="font-bold text-danger block">⚠️ 跨轮改进与待核实事项</span>
              <p className="text-ink leading-relaxed font-sans whitespace-pre-wrap">{data.final_report.weaknesses}</p>
            </div>
            <div className="rounded-xl border border-accent/20 bg-accent-wash/40 p-4 space-y-1.5">
              <span className="font-bold text-accent block">💡 下一步攻坚建议</span>
              <p className="text-ink leading-relaxed font-sans whitespace-pre-wrap">{data.final_report.suggestions}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line/60 text-xs text-muted">
            <span>针对短板可在各单轮报告中一键生成针对性追练题。</span>
            <Link href="/review" className="text-primary hover:underline font-medium">
              前往「复盘看板」查看历史评分趋势 →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
