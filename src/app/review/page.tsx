"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DIMENSIONS, type ScoreMap } from "@/lib/scores";
import { DIM_COLORS, RadarChart, TrendChart } from "@/components/review/score-charts";
import { Empty, Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { btnGhost, btnPrimary, scoreTextCls } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { readReviewDashboard, type ReviewDashboard, type ReviewProjectStat } from "@/lib/review-dashboard";

/** 分数条填充色，档位与 scoreTextCls 一致（≥7 主色 / ≥4 琥珀 / 其余红） */
function scoreBarCls(v: number): string {
  return v >= 7 ? "bg-primary" : v >= 4 ? "bg-accent" : "bg-danger";
}

/** 只比较本次统计中的维度均分；保留全部并列项，同分不强行区分强弱。 */
function WeaknessList({ overall }: { overall: ScoreMap }) {
  const rows = DIMENSIONS.map((d) => ({ ...d, value: overall[d.key] })).sort(
    (a, b) => a.value - b.value
  );
  // DIMENSIONS 是固定四维常量，rows 恒非空
  const lowest = rows[0]!.value;
  const highest = rows[rows.length - 1]!.value;
  const equal = lowest === highest;
  const weakest = rows.filter(row => row.value === lowest);
  const strongest = rows.filter(row => row.value === highest);

  return (
    <div>
      <p className="text-xs leading-relaxed text-muted">
        {equal ? <>四个维度的均分均为 {lowest.toFixed(1)} 分，当前没有分数高低差异。</> : <>
          本次统计中，均分最高的是<span className="font-bold text-primary">{strongest.map(row => row.label).join("、")}</span>
          （{highest.toFixed(1)} 分）；均分最低的是<span className="font-bold text-danger">{weakest.map(row => row.label).join("、")}</span>
          （{lowest.toFixed(1)} 分）。
        </>}
        具体练习重点可结合原题与点评选择。
      </p>
      <ul className="mt-5 space-y-4">
        {rows.map(r => (
          <li key={r.key} className="p-2.5 rounded-xl border border-line/60 bg-surface/30">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-serif font-bold text-ink flex items-center gap-2">
                <span>{r.label}</span>
                {!equal && r.value === lowest && (
                  <span className="rounded-full border border-danger/30 bg-danger-wash px-2 py-0.5 text-[10px] text-danger font-medium">
                    {weakest.length > 1 ? "并列较低" : "相对较低"}
                  </span>
                )}
              </span>
              <span className={`font-mono text-sm font-bold tabular-nums ${scoreTextCls(r.value)}`}>
                {r.value.toFixed(1)} <span className="text-[11px] font-normal text-faint font-sans">/ 10</span>
              </span>
            </div>
            <div role="meter" aria-label={r.label} aria-valuemin={0} aria-valuemax={10} aria-valuenow={r.value} className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full ${scoreBarCls(r.value)}`}
                style={{ width: `${r.value * 10}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-faint">{r.hint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 按项目分布：条形为作答量，右侧 mono 数字为该项目四维均分 */
function ProjectBars({ projects }: { projects: ReviewProjectStat[] }) {
  const max = Math.max(...projects.map((p) => p.answers), 1);
  return (
    <ul className="space-y-3">
      {projects.map((p) => (
        <li key={p.id} className="p-3 rounded-xl border border-line/70 bg-surface/30 space-y-2">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-xs font-serif font-bold text-ink">{p.name}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{p.answers} 题已评分</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-primary" style={{ width: `${(p.answers / max) * 100}%` }} />
            </div>
            <span
              className={`w-12 shrink-0 text-right font-mono text-xs font-bold tabular-nums ${
                p.overall != null ? scoreTextCls(p.overall) : "text-faint"
              }`}
            >
              {p.overall != null ? `${p.overall.toFixed(1)}分` : "—"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function StatCard({
  label,
  children,
  hint,
  highlight,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 shadow-card-subtle space-y-1 transition-all ${
        highlight
          ? "border-primary/30 bg-primary-soft/40 hover:border-primary/60"
          : "border-line bg-card hover:border-primary/40"
      }`}
    >
      <p className={`text-xs font-serif font-medium ${highlight ? "text-primary" : "text-muted"}`}>{label}</p>
      <div className={`font-mono text-3xl font-bold tabular-nums leading-none pt-1.5 ${highlight ? "text-primary" : "text-ink"}`}>
        {children}
      </div>
      {hint && (
        <p className={`text-[11px] font-mono pt-1.5 border-t ${highlight ? "border-primary/20 text-primary/80" : "border-line/60 text-faint"}`}>
          {hint}
        </p>
      )}
    </div>
  );
}

export default function ReviewPage() {
  const [data, setData] = useState<ReviewDashboard | null>(null);
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    jsonFetch<unknown>("/api/review", { cache: "no-store", signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setData(readReviewDashboard(data));
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(err));
      });
    return () => {
      controller.abort();
    };
  }, [loadAttempt]);

  return (
    <div className="mx-auto max-w-[1440px] space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">能力复盘看板</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            跨题目练习与模拟面试聚合四维评分：成绩趋势、维度均分与按项目的已评分作答分布。
          </p>
        </div>
      </div>

      {error && <LoadError message={error} onRetry={() => { setError(""); setLoadAttempt((attempt) => attempt + 1); }} />}
      {!error && data === null && <Loading />}
      {data && data.totals.scoredAnswers === 0 && (
        <Empty
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link href="/drills" className={btnPrimary}>
                开始题目练习
              </Link>
              <Link href="/interviews" className={btnGhost}>
                发起模拟面试
              </Link>
            </div>
          }
        >
          还没有已评分的作答记录。先到「题目练习」答几道题，或完成一场「模拟面试」，这里就会长出你的成绩曲线。
        </Empty>
      )}

      {data && data.totals.scoredAnswers > 0 && (
        <>
          {data.truncated && (
            <p role="status" className="rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-ink">
              本页仅统计部分历史作答：练习和面试各最多纳入 10,000 条有效已评分作答。
              场次数、均分、趋势、维度分析和项目分布均基于纳入的作答，部分场次可能只计入部分题目；其余记录仍保留。
            </p>
          )}
          {/* 四大核心量化指标卡 */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="已评分练习场次" hint="至少一题纳入本次统计">{data.totals.drills}</StatCard>
            <StatCard label="已评分面试场次" hint="至少一题纳入本次统计">{data.totals.interviews}</StatCard>
            <StatCard label="纳入统计的作答数" hint="仅计入有效四维评分">{data.totals.scoredAnswers}</StatCard>
            <StatCard label="本次统计综合均分" hint="按已评分作答汇总" highlight>
              <span>{data.overallScore?.toFixed(1) ?? "—"}</span>
              <span className="ml-1 text-xs font-normal text-primary/70 font-sans">/ 10</span>
            </StatCard>
          </div>

          {/* 趋势折线图 */}
          <section className="space-y-3 pt-2">
            <SectionTitle
              right={
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-faint">● 练习 · ■ 面试</span>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {DIMENSIONS.map((d) => (
                      <span key={d.key} className="flex items-center gap-1.5 text-xs text-muted">
                        <span aria-hidden className="h-2 w-2 rounded-xs" style={{ background: DIM_COLORS[d.key] }} />
                        {d.label}
                      </span>
                    ))}
                  </div>
                </div>
              }
            >
              四维评分成长趋势折线
            </SectionTitle>
            <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
              {data.sessions.length > 0 ? (
                <TrendChart sessions={data.sessions} />
              ) : (
                <p className="py-8 text-center text-sm text-faint">暂无场次数据</p>
              )}
            </div>
          </section>

          {/* 维度雷达与薄弱项分析 */}
          <div className="grid gap-6 lg:grid-cols-2 pt-2">
            <section className="space-y-3">
              <SectionTitle>维度雷达 · 练习 vs 面试对比</SectionTitle>
              <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle flex flex-col items-center justify-center">
                <RadarChart
                  series={[
                    { label: "练习", avg: data.drillAvg, color: "var(--primary)" },
                    { label: "面试", avg: data.interviewAvg, color: "var(--accent)" },
                  ]}
                />
              </div>
            </section>
            <section className="space-y-3">
              <SectionTitle>薄弱维度定向分析</SectionTitle>
              <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
                {data.overall ? (
                  <WeaknessList overall={data.overall} />
                ) : (
                  <p className="py-8 text-center text-sm text-faint">暂无评分数据</p>
                )}
              </div>
            </section>
          </div>

          {/* 按项目分布 */}
          {data.projects.length > 0 && (
            <section className="space-y-3 pt-2">
              <SectionTitle count={data.projects.length}>各项目已评分作答分布</SectionTitle>
              <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
                <ProjectBars projects={data.projects} />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
