"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DIMENSIONS, overallOf, type ScoreMap } from "@/lib/scores";
import { Empty, Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { btnGhost, btnPrimary, scoreTextCls } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type DimKey = (typeof DIMENSIONS)[number]["key"];

type SessionPoint = {
  id: string;
  kind: "drill" | "interview";
  label: string;
  date: string;
  count: number;
  avg: ScoreMap;
  overall: number;
};

type ProjectStat = { id: number; name: string; answers: number; overall: number | null };

type ReviewData = {
  totals: { drills: number; interviews: number; scoredAnswers: number };
  overall: ScoreMap | null;
  overallScore: number | null;
  drillAvg: ScoreMap | null;
  interviewAvg: ScoreMap | null;
  truncated: boolean;
  sessions: SessionPoint[];
  projects: ProjectStat[];
};

/** 四维折线的分类配色：语义令牌，明暗主题自动跟随 */
const DIM_COLORS: Record<DimKey, string> = {
  depth: "var(--primary)",
  structure: "var(--accent)",
  authenticity: "var(--ink)",
  completeness: "var(--danger)",
};

const kindLabel = (k: "drill" | "interview") => (k === "drill" ? "练习" : "面试");

/** 分数条填充色，档位与 scoreTextCls 一致（≥7 主色 / ≥4 琥珀 / 其余红） */
function scoreBarCls(v: number): string {
  return v >= 7 ? "bg-primary" : v >= 4 ? "bg-accent" : "bg-danger";
}

/** 四维评分趋势折线图：X 为场次（按最近作答时间排序），练习画圆点、面试画方块 */
function TrendChart({ sessions }: { sessions: SessionPoint[] }) {
  const W = 640;
  const H = 300;
  const padL = 34;
  const padR = 14;
  const padT = 14;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = sessions.length;
  const x = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - v / 10) * plotH;
  const labelStep = Math.max(1, Math.ceil(n / 12));

  const tooltip = (s: SessionPoint, d: (typeof DIMENSIONS)[number]) =>
    `${d.label} ${s.avg[d.key].toFixed(1)} 分 · ${kindLabel(s.kind)}「${s.label}」· ${new Date(s.date).toLocaleString()}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="四维评分趋势折线图">
      {[0, 2, 4, 6, 8, 10].map((g) => (
        <g key={g}>
          <line x1={padL} x2={W - padR} y1={y(g)} y2={y(g)} stroke="var(--line)" strokeWidth={1} />
          <text
            x={padL - 6}
            y={y(g) + 3}
            textAnchor="end"
            fontSize={10}
            fill="var(--faint)"
            className="font-mono tabular-nums"
          >
            {g}
          </text>
        </g>
      ))}
      {sessions.map((s, i) =>
        i % labelStep === 0 || i === n - 1 ? (
          <text
            key={s.id}
            x={x(i)}
            y={H - padB + 18}
            textAnchor="middle"
            fontSize={10}
            fill="var(--faint)"
            className="font-mono tabular-nums"
          >
            {s.date.slice(5, 10)}
          </text>
        ) : null
      )}
      {DIMENSIONS.map((d) => (
        <g key={d.key}>
          {n > 1 && (
            <polyline
              points={sessions.map((s, i) => `${x(i)},${y(s.avg[d.key])}`).join(" ")}
              fill="none"
              stroke={DIM_COLORS[d.key]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {sessions.map((s, i) =>
            s.kind === "drill" ? (
              <circle key={s.id} cx={x(i)} cy={y(s.avg[d.key])} r={3.5} fill={DIM_COLORS[d.key]}>
                <title>{tooltip(s, d)}</title>
              </circle>
            ) : (
              <rect
                key={s.id}
                x={x(i) - 3.5}
                y={y(s.avg[d.key]) - 3.5}
                width={7}
                height={7}
                rx={1}
                fill={DIM_COLORS[d.key]}
              >
                <title>{tooltip(s, d)}</title>
              </rect>
            )
          )}
        </g>
      ))}
    </svg>
  );
}

/** 四维雷达：练习 vs 面试两组多边形叠加对比 */
function RadarChart({
  series,
}: {
  series: { label: string; avg: ScoreMap | null; color: string }[];
}) {
  const W = 320;
  const H = 276;
  const cx = W / 2;
  const cy = 138;
  const R = 84;
  const axes = DIMENSIONS.map((d, i) => ({ d, angle: -Math.PI / 2 + (i * Math.PI) / 2 }));
  const pt = (i: number, v: number): [number, number] => {
    const angle = axes[i]?.angle ?? 0;
    return [
      cx + (Math.cos(angle) * R * v) / 10,
      cy + (Math.sin(angle) * R * v) / 10,
    ];
  };
  const ring = (v: number) => axes.map((_, i) => pt(i, v).join(",")).join(" ");

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="练习与面试的四维雷达对比图">
        {[2.5, 5, 7.5].map((v) => (
          <polygon key={v} points={ring(v)} fill="none" stroke="var(--line)" strokeWidth={1} />
        ))}
        <polygon points={ring(10)} fill="none" stroke="var(--line-strong)" strokeWidth={1} />
        {axes.map((ax, i) => {
          const [sx, sy] = pt(i, 10);
          return <line key={ax.d.key} x1={cx} y1={cy} x2={sx} y2={sy} stroke="var(--line)" strokeWidth={1} />;
        })}
        <text x={cx + 4} y={cy - R / 2 - 2} fontSize={9} fill="var(--faint)" className="font-mono tabular-nums">
          5
        </text>
        <text x={cx + 4} y={cy - R - 2} fontSize={9} fill="var(--faint)" className="font-mono tabular-nums">
          10
        </text>
        {series.map((s) => {
          if (!s.avg) return null;
          const points = axes.map((ax, i) => pt(i, s.avg![ax.d.key]).join(",")).join(" ");
          return (
            <g key={s.label}>
              <polygon points={points} fill={s.color} fillOpacity={0.18} stroke={s.color} strokeWidth={2} />
              {axes.map((ax, i) => {
                const [x, y] = pt(i, s.avg![ax.d.key]);
                return <circle key={ax.d.key} cx={x} cy={y} r={3} fill={s.color} />;
              })}
            </g>
          );
        })}
        {axes.map((ax) => {
          const labelDist = R + 18;
          const lx = cx + Math.cos(ax.angle) * labelDist;
          const ly = cy + Math.sin(ax.angle) * labelDist + 4;
          return (
            <text
              key={ax.d.key}
              x={lx}
              y={ly}
              textAnchor="middle"
              fontSize={11}
              fill="var(--ink)"
              className="font-serif font-bold"
            >
              {ax.d.label}
            </text>
          );
        })}
      </svg>
      <div className="mt-2 flex justify-center gap-6 text-xs">
        {series.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-2.5 rounded-xs" style={{ background: s.color }} />
            <span className="font-medium text-ink">{s.label}</span>
            <span className="font-mono text-faint">
              {s.avg ? `(均 ${overallOf(s.avg)})` : "(暂无)"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 薄弱维度排查：按分值升序排列，标出最薄弱项与改进行动点 */
function WeaknessList({ overall }: { overall: ScoreMap }) {
  const rows = DIMENSIONS.map((d) => ({ ...d, value: overall[d.key] })).sort(
    (a, b) => a.value - b.value
  );
  // DIMENSIONS 是固定四维常量，rows 恒非空
  const weakest = rows[0]!;
  const strongest = rows[rows.length - 1]!;

  return (
    <div>
      <p className="text-xs leading-relaxed text-muted">
        四维综合均分透视：当前全周期最具优势的是
        <span className="font-bold text-primary ml-1 mr-1">{strongest.label}</span>
        ，最需补强的是
        <span className="font-bold text-danger ml-1 mr-1">{weakest.label}</span>
        （{weakest.hint}）。
      </p>
      <ul className="mt-5 space-y-4">
        {rows.map((r, idx) => (
          <li key={r.key} className="p-2.5 rounded-xl border border-line/60 bg-surface/30">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-serif font-bold text-ink flex items-center gap-2">
                <span>{r.label}</span>
                {idx === 0 && (
                  <span className="rounded-full border border-danger/30 bg-danger-wash px-2 py-0.5 text-[10px] text-danger font-medium">
                    核心补强项
                  </span>
                )}
              </span>
              <span className={`font-mono text-sm font-bold tabular-nums ${scoreTextCls(r.value)}`}>
                {r.value.toFixed(1)} <span className="text-[11px] font-normal text-faint font-sans">/ 10</span>
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className={`h-full rounded-full ${scoreBarCls(r.value)}`}
                style={{ width: `${Math.max(r.value, 0.4) * 10}%` }}
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
function ProjectBars({ projects }: { projects: ProjectStat[] }) {
  const max = Math.max(...projects.map((p) => p.answers), 1);
  return (
    <ul className="space-y-3">
      {projects.map((p) => (
        <li key={p.id} className="p-3 rounded-xl border border-line/70 bg-surface/30 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-xs font-serif font-bold text-ink">{p.name}</span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">{p.answers} 题已练</span>
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
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    jsonFetch<ReviewData>("/api/review")
      .then((data) => {
        if (cancelled) return;
        setData(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  return (
    <div className="mx-auto max-w-[1440px] space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">能力复盘看板</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            跨题目练习与模拟面试聚合四维评分：成绩趋势、维度强弱与按项目的作答深度分布。
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
              趋势图只显示每类最近 10,000 条已评分作答；更早记录仍保留在数据库中。
            </p>
          )}
          {/* 四大核心量化指标卡 */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="题目练习场次" hint="包含项目深挖与通用八股">{data.totals.drills}</StatCard>
            <StatCard label="模拟实战考场" hint="单轮模考与三轮连打">{data.totals.interviews}</StatCard>
            <StatCard label="累计评分题数" hint="四维度即时打分题">{data.totals.scoredAnswers}</StatCard>
            <StatCard label="全周期综合均分" hint="四维均值成长基线" highlight>
              <span>{(data.overallScore ?? 0).toFixed(1)}</span>
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
              <SectionTitle count={data.projects.length}>各项目作答深度画像</SectionTitle>
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
