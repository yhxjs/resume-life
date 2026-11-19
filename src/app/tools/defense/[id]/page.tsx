"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { useToolHistoryDeletion } from "@/hooks/use-tool-history-deletion";
import { jsonFetch } from "@/lib/fetcher";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  cardCls,
} from "@/lib/ui";
import type {
  DefenseDrillRecord,
  ResumeDefenseReport,
  ScannedDefenseItem,
} from "@/lib/resume-defense";
import { DefenseDrillDrawer } from "@/components/defense/defense-drill-drawer";
import { DefenseQuote } from "@/components/defense/defense-quote";
import { DefenseRiskLevelTag, DefenseRiskTypeTag } from "@/components/defense/defense-badges";
import { readDefenseDetail } from "@/lib/resume-defense-detail";
import { errorMessage } from "@/lib/error-message";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";

export default function ResumeDefenseDetailPage() {
  const params = useParams<{ id: string }>();
  return <DefenseDetail key={params.id} id={params.id} />;
}

function DefenseDetail({ id }: { id: string }) {
  const router = useRouter();

  const [report, setReport] = useState<ResumeDefenseReport | null>(null);
  const [drills, setDrills] = useState<DefenseDrillRecord[]>([]);
  const [loadError, setLoadError] = useState("");
  const active = useRef(false);
  const deletion = useToolHistoryDeletion("resume-defenses", () => router.push("/tools/defense"));
  const deleted = report !== null && deletion.deletedIds.has(report.id);

  // 侧边抽屉状态
  const [activeItem, setActiveItem] = useState<ScannedDefenseItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    jsonFetch<unknown>(
      `/api/tools/resume-defenses/${id}`, { signal: controller.signal, cache: "no-store" }
    )
      .then((res) => {
        if (cancelled) return;
        const data = readDefenseDetail(res, id);
        setReport(data.report);
        setDrills(data.drills);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, loadAttempt]);

  function openDrill(item: ScannedDefenseItem) {
    if (!active.current || deletion.busy || deleted) return;
    setActiveItem(item);
    setDrawerOpen(true);
  }

  function handleDrillSaved(newDrill: DefenseDrillRecord) {
    if (!active.current || !report || newDrill.defenseId !== report.id) return;
    setDrills((prev) => {
      const idx = prev.findIndex((d) => d.itemId === newDrill.itemId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = newDrill;
        return next;
      }
      return [...prev, newDrill];
    });
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-4xl p-6 text-center space-y-4">
        <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />
        <Link href="/tools/defense" className={`${btnGhost} text-xs`}>
          返回排雷列表
        </Link>
      </div>
    );
  }

  if (!report) {
    return <Loading label="正在读取简历排雷报告…" />;
  }

  if (deleted) return <div className="space-y-3">
    <p role="status">报告已不存在，正在返回排雷列表…</p>
    <Link href="/tools/defense" className={btnGhost}>返回排雷列表</Link>
  </div>;

  const drillsMap = new Map(drills.map((d) => [d.itemId, d]));

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 [overflow-wrap:anywhere]">
      <ToolHistoryDeletionFeedback deletion={deletion} />
      {/* 顶栏导航 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            href="/tools/defense"
            className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-card text-muted hover:text-ink hover:bg-surface transition-colors shadow-xs"
            title="返回排雷工具"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
            </svg>
          </Link>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-serif text-2xl sm:text-3xl font-bold text-ink">{report.title}</h1>
              <ResumeVersionBadge resume_version_id={report.resumeVersionId} />
              <DefenseRiskLevelTag level={report.riskLevel} />
            </div>
            {report.targetRole && (
              <p className="text-xs text-muted mt-0.5">
                目标岗位：<span className="font-medium text-ink">{report.targetRole}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/tools/defense" className={`${btnGhost} text-xs cursor-pointer border border-line`}>
            新建排雷扫描
          </Link>
          <button
            type="button"
            onClick={() => void deletion.remove(report.id, report.title)}
            disabled={deletion.busy}
            className={`${btnDanger} text-xs cursor-pointer`}
          >
            删除报告
          </button>
        </div>
      </div>

      {/* 毒舌面试官总体吐槽 */}
      <div className="rounded-2xl border border-danger/30 bg-gradient-to-br from-danger-wash/60 via-card to-card p-6 shadow-card-subtle space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-danger/10 text-danger font-bold text-base">
              🔎
            </span>
            <span className="font-serif text-base font-bold text-ink">
              简历表述审阅 · 整体建议
            </span>
          </div>
          <span className="text-[11px] text-faint font-mono">
            {new Date(report.createdAt).toLocaleString()}
          </span>
        </div>
        <p className="text-xs sm:text-sm text-ink leading-relaxed font-sans bg-card/70 border border-line/60 rounded-xl p-4">
          &ldquo;{report.overallRoast}&rdquo;
        </p>
        <p className="text-xs text-muted leading-relaxed">以下内容基于本次材料生成，是待核实线索，不是事实认定；练习参考不代表你的真实经历。</p>
      </div>

      {/* 抓出的软肋列表 */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <SectionTitle count={report.items.length}>
            待核实表述与练习参考
          </SectionTitle>
          <span className="text-xs text-muted">
            已完成演练: <b className="font-mono text-ink">{drills.length}</b> / {report.items.length}
          </span>
        </div>

        <div className="space-y-5">
          {report.items.map((item, idx) => {
            const existingDrill = drillsMap.get(item.id);

            return (
              <div
                key={item.id}
                className={`${cardCls} p-5 sm:p-6 space-y-4 hover:border-line-strong transition-colors`}
              >
                {/* 卡片头部 */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-surface font-mono text-xs font-bold text-muted border border-line">
                      #{idx + 1}
                    </span>
                    <DefenseRiskTypeTag type={item.riskType} />
                    <span className="text-xs text-faint">模块: {item.sectionHint}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {existingDrill && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-0.5 text-xs text-muted border border-line font-mono">
                        <span>已演练得分:</span>
                        {existingDrill.defenseScore >= 0 && existingDrill.defenseScore <= 100
                          ? <b className={existingDrill.defenseScore >= 90 ? "text-primary" : existingDrill.defenseScore >= 50 ? "text-accent" : "text-danger"}>{existingDrill.defenseScore}分</b>
                          : <span>未提供有效演练分数</span>}
                      </span>
                    )}

                    <button
                      type="button"
                      onClick={() => openDrill(item)}
                      disabled={deletion.busy}
                      className={`${btnPrimary} text-xs py-1.5 px-3 cursor-pointer`}
                    >
                      <span aria-hidden>🛡️</span>
                      <span>{existingDrill ? "查看/重做对练" : "即刻防御演练"}</span>
                    </button>
                  </div>
                </div>

                {/* 原文高亮摘录 */}
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-muted flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                    <span>引用预览：</span>
                  </div>
                  <div className="rounded-xl border border-danger/20 bg-danger-wash/30 p-3 font-mono text-xs text-ink leading-relaxed break-words">
                    <DefenseQuote text={item.originalText} />
                  </div>
                </div>

                {/* 毒舌吐槽 */}
                <div className="space-y-1.5 rounded-xl border border-line/80 bg-surface/40 p-3.5 text-xs">
                  <div className="flex items-center gap-1.5 font-bold text-danger text-[11px]">
                    <span>💬 表述点评：</span>
                  </div>
                  <p className="text-ink leading-relaxed font-sans">{item.interviewerRoast}</p>
                </div>

                {/* 致命连环追问 */}
                <div className="space-y-2">
                  <span className="text-xs font-bold text-ink flex items-center gap-1.5">
                    <span>🎯 可练习的追问：</span>
                  </span>
                  <div className="space-y-1.5">
                    {(item.deadlyQuestions || []).map((q, qIdx) => (
                      <div
                        key={qIdx}
                        className="flex items-start gap-2.5 rounded-lg border border-line bg-card p-2.5 text-xs text-ink"
                      >
                        <span className="shrink-0 mt-0.5 rounded bg-surface px-1.5 py-0.2 font-mono text-[10px] text-faint border border-line">
                          追问 {qIdx + 1}
                        </span>
                        <span className="min-w-0 leading-relaxed">{q}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 防御应答预案 */}
                <div className="rounded-xl border border-line bg-surface/30 p-4 space-y-3 text-xs">
                  <div className="font-serif font-bold text-ink flex items-center gap-1.5 text-xs">
                    <span>🛡️ 追问分析与练习参考</span>
                  </div>

                  <div className={`grid grid-cols-1 ${item.defensePlan?.tabooMistakes?.length ? "md:grid-cols-2" : ""} gap-3 pt-1`}>
                    <div className="space-y-1">
                      <span className="font-semibold text-muted text-[11px] block">
                        🧐 追问可能核实的信息：
                      </span>
                      <p className="text-ink leading-relaxed bg-card p-2.5 rounded-lg border border-line/60">
                        {item.defensePlan?.interviewerIntent}
                      </p>
                    </div>

                    {!!item.defensePlan?.tabooMistakes?.length && (
                      <div className="space-y-1">
                        <span className="font-semibold text-danger text-[11px] block">
                          🚫 应避免的失实表达：
                        </span>
                        <ul className="space-y-1 bg-card p-2.5 rounded-lg border border-line/60">
                          {item.defensePlan.tabooMistakes.map((t, tIdx) => (
                            <li key={tIdx} className="text-danger/90 leading-relaxed flex items-start gap-1">
                              <span>•</span>
                              <span>{t}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1 pt-1">
                    <span className="font-semibold text-primary text-[11px] block">
                      💡 练习参考（按已确认事实调整）：
                    </span>
                    <div className="rounded-lg border border-primary/20 bg-primary-soft/20 p-3 text-ink leading-relaxed font-sans">
                      {item.defensePlan?.standardDefense}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 侧边抽屉即问即评演练 */}
      <DefenseDrillDrawer
        defenseId={report.id}
        item={activeItem}
        existingDrill={activeItem ? drillsMap.get(activeItem.id) : null}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onDrillSaved={handleDrillSaved}
        onDrillsReloaded={(records) => { if (active.current) setDrills(records); }}
      />
    </div>
  );
}
