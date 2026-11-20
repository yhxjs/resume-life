import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDatabaseStats } from "@/lib/backup";
import { getApplicationStats } from "@/lib/applications";
import { getOverallScore } from "@/lib/overall-score";
import { resolveSession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { STAGES } from "./home-stages";
import { TodayReviews } from "@/components/reviews/today-reviews";
import { TodayPriorities } from "@/components/home/today-priorities";
import { HomeIcon } from "@/components/home/home-icon";
import homeStyles from "@/components/home/home.module.css";

export const dynamic = "force-dynamic";

/** 包装成功值，区分合法的无评分 null 与读取失败；各组统计独立降级。 */
function readStats<T>(read: () => T): { value: T } | null {
  try {
    return { value: read() };
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
  const dbStats = readStats(getDatabaseStats)?.value ?? null;
  const appStats = readStats(getApplicationStats)?.value ?? null;
  const scoreStats = readStats(getOverallScore);
  const statsUnavailable = dbStats === null || appStats === null || scoreStats === null;
  const overallScore = scoreStats?.value ?? null;

  const totalInterviewsAndDrills = dbStats ? dbStats.interviews + dbStats.drills : null;

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      {/* 统计读取失败时的降级提示：数据库未就绪或初始化失败，入口页仍要能打开 */}
      {statsUnavailable && (
        <div role="alert" className="flex flex-wrap items-center gap-2.5 rounded-xl border border-danger/30 bg-danger-wash px-4 py-3 text-sm text-ink shadow-card-subtle">
          <span className="flex h-2.5 w-2.5 shrink-0 rounded-full bg-danger" />
          <span className="font-serif font-bold text-danger shrink-0">统计数据暂不可用：</span>
          <span className="min-w-0 text-ink">
            不可用项显示为“—”，其他已读取数据仍保留。请刷新页面重试。
          </span>
        </div>
      )}

      <TodayPriorities />

      <nav aria-label="快捷行动" className={`${homeStyles.quickActions} grid grid-cols-3 overflow-hidden rounded-2xl border border-line bg-card`}>
        <Link href="/applications" className="group flex min-w-0 flex-col items-center gap-2.5 px-2 py-4 text-center transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-primary sm:flex-row sm:gap-3 sm:px-5 sm:text-left">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft/60 text-primary transition-colors group-hover:bg-primary-soft"><HomeIcon kind="applications" /></span>
          <span className="min-w-0"><span className="block text-xs font-semibold text-ink sm:text-sm">求职漏斗看板</span><span className="mt-1 block text-[11px] text-muted">{appStats ? (appStats.totalActive > 0 ? `${appStats.totalActive} 条推进中 →` : "进入管理 →") : "查看看板 →"}</span></span>
        </Link>
        <Link href="/interviews" className="group flex min-w-0 flex-col items-center gap-2.5 px-2 py-4 text-center transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-primary sm:flex-row sm:gap-3 sm:px-5 sm:text-left">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-wash text-accent"><HomeIcon kind="interview" /></span>
          <span className="min-w-0"><span className="block text-xs font-semibold text-ink sm:text-sm">开启全真模考</span><span className="mt-1 block text-[11px] text-muted">练习表达 →</span></span>
        </Link>
        <Link href="/resumes" className="group flex min-w-0 flex-col items-center gap-2.5 px-2 py-4 text-center transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-primary sm:flex-row sm:gap-3 sm:px-5 sm:text-left">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft/60 text-primary transition-colors group-hover:bg-primary-soft"><HomeIcon kind="materials" /></span>
          <span className="min-w-0"><span className="block text-xs font-semibold text-ink sm:text-sm">管理我的简历</span><span className="mt-1 block text-[11px] text-muted">{dbStats ? `${dbStats.resumes} 份已存 →` : "查看简历 →"}</span></span>
        </Link>
      </nav>

      {/* 4 宫格数字档案指标概览 */}
      <section aria-label="求职概览" className={`${homeStyles.metrics} grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-card lg:grid-cols-4`}>
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
              {dbStats?.resumes ?? "—"}
            </span>
            <span className="text-xs text-faint">份已存简历</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>{dbStats ? "支持 A4 打印与导出" : "简历统计读取失败"}</span>
            <span className="shrink-0 whitespace-nowrap font-medium text-primary group-hover:underline">查看 ↗</span>
          </div>
        </Link>

        <Link
          href="/applications"
          className="group rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all hover:border-accent/40 hover:bg-surface/30"
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>推进中的投递</span>
            <span className="h-2 w-2 rounded-full bg-accent/40 transition-colors group-hover:bg-accent" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums text-accent">
              {appStats?.totalActive ?? "—"}
            </span>
            <span className="text-xs text-faint">条投递记录</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>{appStats ? `面试中 ${appStats.counts.interviewing} · Offer ${appStats.counts.offer}` : "投递统计读取失败"}</span>
            <span className="shrink-0 whitespace-nowrap font-medium text-accent group-hover:underline">看板 ↗</span>
          </div>
        </Link>

        <Link
          href="/interviews"
          className="group rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all hover:border-primary/40 hover:bg-surface/30"
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>模考与练习</span>
            <span className="h-2 w-2 rounded-full bg-primary/40 transition-colors group-hover:bg-primary" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-bold tabular-nums text-ink">
              {totalInterviewsAndDrills ?? "—"}
            </span>
            <span className="text-xs text-faint">条演练记录</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>{dbStats ? `${dbStats.interviews} 场模考 · ${dbStats.drills} 组练习` : "演练统计读取失败"}</span>
            <span className="shrink-0 whitespace-nowrap font-medium text-primary group-hover:underline">演练 ↗</span>
          </div>
        </Link>

        <Link
          href="/review"
          className="group rounded-xl border border-line bg-card p-4 shadow-card-subtle transition-all hover:border-primary/40 hover:bg-surface/30"
        >
          <div className="flex items-center justify-between text-xs text-muted">
            <span>历史四维均分</span>
            <span className="h-2 w-2 rounded-full bg-primary/40 transition-colors group-hover:bg-primary" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            {overallScore !== null ? (
              <>
                <span className="font-mono text-3xl font-bold tabular-nums text-primary">
                  {overallScore.toFixed(1)}
                </span>
                <span className="text-xs text-faint">/ 10 分</span>
              </>
            ) : (
              <>
                <span className="font-serif text-xl font-bold text-muted">
                  {scoreStats ? "暂无评分" : "—"}
                </span>
              </>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-line/60 pt-2 text-[11px] text-muted">
            <span>
              {scoreStats === null ? "评分读取失败，请刷新重试" : overallScore !== null ? "基于已评分的练习与模考" : "练习或模考评分后显示"}
            </span>
            <span className="shrink-0 whitespace-nowrap font-medium text-primary group-hover:underline">复盘 ↗</span>
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
