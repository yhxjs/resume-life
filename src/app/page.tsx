import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDatabaseStats, type DatabaseStats } from "@/lib/backup";
import { getApplicationStats, type ApplicationStats } from "@/lib/applications";
import { getOverallScore } from "@/lib/overall-score";
import { resolveSession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { STAGES } from "./home-stages";
import { TodayReviews } from "@/components/reviews/today-reviews";

export const dynamic = "force-dynamic";

const EMPTY_DB_STATS: DatabaseStats = {
  resumes: 0,
  projects: 0,
  interviews: 0,
  drills: 0,
  bank_entries: 0,
  notebook_entries: 0,
  intros: 0,
  templates: 0,
  totalRecords: 0,
  hasAiConfig: false,
  dbVersion: 0,
};

const EMPTY_APPLICATION_STATS: ApplicationStats = {
  counts: { interested: 0, applied: 0, interviewing: 0, interview: 0, reviewing: 0, offer: 0, rejected: 0 },
  totalActive: 0,
  upcomingInterviews: [],
  rates: { appliedRate: 0, interviewRate: 0, offerRate: 0 },
};

/** 统计读取失败时返回 null 降级：入口页仍要渲染出来，好让用户看到错误提示与排障指引 */
function readStats<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

export default async function HomePage() {
  // 首页是唯一在 SSR 阶段直接读库的页面：proxy 只做 cookie 在场检查，
  // 这里必须对会话做真实校验，避免伪造 cookie 时服务端渲染出统计数据。
  const cookieStore = await cookies();
  if (!resolveSession(cookieStore.get(SESSION_COOKIE_NAME)?.value)) {
    redirect("/login");
  }
  // 服务端同步直调数据
  const rawDbStats = readStats(getDatabaseStats);
  const rawAppStats = readStats(getApplicationStats);
  const dbStats = rawDbStats ?? EMPTY_DB_STATS;
  const appStats = rawAppStats ?? EMPTY_APPLICATION_STATS;
  const statsUnavailable = rawDbStats === null || rawAppStats === null;
  const overallScore = getOverallScore();

  const totalInterviewsAndDrills = dbStats.interviews + dbStats.drills;
  const upcoming = appStats.upcomingInterviews?.[0]; // 最近一场待办面试

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {/* 统计读取失败时的降级提示：数据库未就绪或初始化失败，入口页仍要能打开 */}
      {statsUnavailable && (
        <div className="flex items-center gap-2.5 rounded-xl border border-danger/30 bg-danger-wash px-4 py-3 text-sm text-ink shadow-card-subtle">
          <span className="flex h-2.5 w-2.5 shrink-0 rounded-full bg-danger" />
          <span className="font-serif font-bold text-danger shrink-0">统计数据暂不可用：</span>
          <span className="min-w-0 text-ink">
            下方数值按 0 显示。数据库可能未就绪或初始化失败，请对照
            <span className="mx-1 font-mono text-xs">docs/TROUBLESHOOTING.md</span>
            排查。
          </span>
        </div>
      )}

      {/* 待办面试快速提醒条（若有未来 7 天待办面试） */}
      {upcoming && (
        <div className="flex items-center justify-between gap-4 rounded-xl border border-accent/30 bg-accent-wash px-4 py-3 text-sm text-ink shadow-card-subtle">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-2.5 w-2.5 shrink-0 rounded-full bg-accent animate-pulse" />
            <span className="font-serif font-bold text-accent shrink-0">面试日程提醒：</span>
            <span className="truncate text-ink">
              <strong>{upcoming.company}</strong> · {upcoming.role}
              {upcoming.next_interview_at && (
                <span className="ml-2 font-mono text-xs text-muted">
                  ({new Date(upcoming.next_interview_at).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })})
                </span>
              )}
            </span>
          </div>
          <Link
            href="/applications"
            className="shrink-0 text-xs font-medium text-accent hover:underline flex items-center gap-1"
          >
            <span>查看日程</span>
            <span aria-hidden>→</span>
          </Link>
        </div>
      )}

      {/* 顶部 Hero 工作台区域 */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-card p-6 sm:p-8 lg:p-10 shadow-card-subtle bg-grain">
        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-8">
          <div className="max-w-2xl space-y-4">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary-soft px-3 py-1 text-xs font-medium text-primary">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span>全生命周期 · 结构化求职备考工作台</span>
            </div>

            <h1 className="font-serif text-[30px] font-bold leading-tight text-ink sm:text-[38px] lg:text-[42px] tracking-tight">
              智者善谋，以弈求生。
            </h1>
            <div aria-hidden className="h-1 w-12 rounded-full bg-primary" />

            <p className="max-w-prose text-sm leading-relaxed text-muted sm:text-[15px]">
              AI 驱动的结构化求职体系：从沉淀真实技术素材、打磨打印级 A4 简历，到全真高压多轮模考与四维弱项归因 —— 一处通关求职全程。
            </p>
          </div>

          {/* 快捷核心行动卡片 */}
          <div className="flex flex-col sm:flex-row lg:flex-col gap-3 shrink-0 lg:w-72">
            <Link
              href="/applications"
              className="group flex items-center justify-between gap-3 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-on-primary shadow-xs transition-all hover:bg-primary-hover"
            >
              <div className="flex items-center gap-2.5">
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-4 w-4 shrink-0 text-on-primary/90"
                  aria-hidden
                >
                  <path d="M2 4.25A2.25 2.25 0 0 1 4.25 2h11.5A2.25 2.25 0 0 1 18 4.25v11.5A2.25 2.25 0 0 1 15.75 18H4.25A2.25 2.25 0 0 1 2 15.75V4.25Z" />
                </svg>
                <span>求职漏斗看板</span>
              </div>
              <span className="text-xs text-on-primary/80 transition-transform group-hover:translate-x-0.5">
                {appStats.totalActive > 0 ? `${appStats.totalActive} 家推进中 →` : "进入管理 →"}
              </span>
            </Link>

            <Link
              href="/interviews"
              className="group flex items-center justify-between gap-3 rounded-xl border border-line-strong bg-card px-4 py-2.5 text-sm font-medium text-ink transition-all hover:bg-surface hover:border-primary/40 shadow-xs"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-2 w-2 rounded-full bg-accent" />
                <span>开启全真模考</span>
              </div>
              <span className="text-xs text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-primary">
                技术/HR 连打 →
              </span>
            </Link>

            <Link
              href="/resumes"
              className="group flex items-center justify-between gap-3 rounded-xl border border-line-strong bg-card px-4 py-2.5 text-sm font-medium text-ink transition-all hover:bg-surface hover:border-primary/40 shadow-xs"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-2 w-2 rounded-full bg-primary" />
                <span>管理我的简历</span>
              </div>
              <span className="text-xs text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-primary">
                {dbStats.resumes} 份已存 →
              </span>
            </Link>
          </div>
        </div>

        {/* 右下角文房印章装饰水印 */}
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-6 -right-3 select-none font-serif text-[130px] font-black text-ink opacity-[0.03]"
        >
          弈
        </div>
      </section>

      {/* 4 宫格数字档案指标概览 */}
      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Link
          href="/resumes"
          className="group rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all hover:border-primary/40 hover:bg-surface/30"
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>维护简历</span>
            <span className="h-2 w-2 rounded-full bg-primary/40 transition-colors group-hover:bg-primary" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums text-ink">
              {dbStats.resumes}
            </span>
            <span className="text-xs text-faint">份不同定制版</span>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>支持 A4 打印与导出</span>
            <span className="font-medium text-primary group-hover:underline">查看 ↗</span>
          </div>
        </Link>

        <Link
          href="/applications"
          className="group rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all hover:border-accent/40 hover:bg-surface/30"
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>活跃投递中</span>
            <span className="h-2 w-2 rounded-full bg-accent/40 transition-colors group-hover:bg-accent" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums text-accent">
              {appStats.totalActive}
            </span>
            <span className="text-xs text-faint">家进入流程</span>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>{appStats.counts.interviewing} 家约面 · {appStats.counts.offer} 录用</span>
            <span className="font-medium text-accent group-hover:underline">看板 ↗</span>
          </div>
        </Link>

        <Link
          href="/interviews"
          className="group rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all hover:border-primary/40 hover:bg-surface/30"
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>实战模考演练</span>
            <span className="h-2 w-2 rounded-full bg-primary/40 transition-colors group-hover:bg-primary" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums text-ink">
              {totalInterviewsAndDrills}
            </span>
            <span className="text-xs text-faint">场模拟已完成</span>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>{dbStats.interviews} 模考 · {dbStats.drills} 专项题</span>
            <span className="font-medium text-primary group-hover:underline">演练 ↗</span>
          </div>
        </Link>

        <Link
          href="/review"
          className="group rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all hover:border-primary/40 hover:bg-surface/30"
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>四维综合胜率</span>
            <span className="h-2 w-2 rounded-full bg-primary/40 transition-colors group-hover:bg-primary" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            {overallScore !== null ? (
              <>
                <span className="font-mono text-3xl font-bold tabular-nums text-primary">
                  {overallScore.toFixed(1)}
                </span>
                <span className="text-xs text-faint">/ 10 分综合评级</span>
              </>
            ) : (
              <>
                <span className="font-serif text-xl font-bold text-muted">
                  {dbStats.hasAiConfig ? "准备就绪" : "待配置"}
                </span>
                <span className="text-xs text-faint">AI 驱动</span>
              </>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>
              {overallScore !== null ? "基于历史真实答题均分" : "完成首次模考即可生成"}
            </span>
            <span className="font-medium text-primary group-hover:underline">复盘 ↗</span>
          </div>
        </Link>
      </section>

      <TodayReviews />

      {/* 2×2 四阶段进阶矩阵 */}
      <section className="space-y-6 pt-2">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <h2 className="font-serif text-base sm:text-lg font-bold text-ink">
              备考通关进阶矩阵
            </h2>
          </div>
          <span className="text-xs text-muted hidden sm:inline">
            循序渐进，从经历储备到临场斩获 Offer
          </span>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {STAGES.map((group) => (
            <div
              key={group.stage}
              className={`relative flex flex-col justify-between rounded-2xl border bg-card p-5 sm:p-6 shadow-card-subtle transition-all duration-200 ${
                group.isCore
                  ? "border-primary/40 ring-1 ring-primary/10"
                  : "border-line"
              }`}
            >
              {/* 核心考场角标 */}
              {group.isCore && (
                <div className="absolute right-0 top-0 rounded-bl-xl bg-primary px-3 py-1 text-[11px] font-bold text-on-primary shadow-xs">
                  重点攻坚战场
                </div>
              )}

              <div>
                {/* 阶段标题头 */}
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-3">
                  <div className="flex items-center gap-2.5">
                    <span className="rounded bg-primary-soft px-2 py-0.5 font-mono text-xs font-bold text-primary">
                      {group.tag}
                    </span>
                    <h3 className="font-serif text-[16px] font-bold text-ink">
                      {group.title}
                    </h3>
                  </div>
                  <span className={`text-xs text-faint ${group.isCore ? "pr-20" : ""}`}>
                    {group.sub}
                  </span>
                </div>

                <p className="mt-2.5 mb-4 text-xs leading-relaxed text-muted">
                  {group.desc}
                </p>

                {/* 模块小卡片网格 */}
                <div
                  className={`grid gap-3 ${
                    group.items.length === 4
                      ? "grid-cols-1 sm:grid-cols-2"
                      : "grid-cols-1 sm:grid-cols-3"
                  }`}
                >
                  {group.items.map((f) => (
                    <Link
                      key={f.href}
                      href={f.href}
                      className={`group flex flex-col justify-between rounded-xl p-3.5 transition-all duration-150 ${
                        f.highlight
                          ? "border border-primary/40 bg-primary-soft/30 hover:bg-primary-soft/60 shadow-xs"
                          : "border border-line/80 bg-surface/40 hover:border-primary/40 hover:bg-surface shadow-xs"
                      }`}
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-1">
                          <span
                            className={`font-serif text-sm font-bold transition-colors ${
                              f.highlight
                                ? "text-primary"
                                : "text-ink group-hover:text-primary"
                            }`}
                          >
                            {f.title}
                          </span>
                          {f.badge && (
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-normal ${
                                f.highlight
                                  ? "bg-primary text-on-primary"
                                  : f.primaryBadge
                                  ? "bg-primary-soft text-primary font-medium"
                                  : "border border-line bg-card text-muted"
                              }`}
                            >
                              {f.badge}
                            </span>
                          )}
                        </div>
                        <p className="text-xs leading-relaxed text-muted line-clamp-3 group-hover:text-ink/80 transition-colors">
                          {f.desc}
                        </p>
                      </div>

                      <div className="mt-3 flex items-center justify-end text-xs text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-primary">
                        <span aria-hidden>→</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>

              {/* 阶段底部状态与行动 */}
              <div className="mt-5 flex items-center justify-between border-t border-line/60 pt-3 text-xs text-muted">
                <span className="truncate">{group.footerText}</span>
                <Link
                  href={group.footerLink}
                  className="shrink-0 font-medium text-primary hover:underline"
                >
                  {group.footerLinkText}
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
