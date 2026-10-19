"use client";

import { useEffect, useRef, useState } from "react";
import { Loading } from "@/components/common/ui-bits";
import { alertDialog } from "@/components/common/confirm-dialog";
import { btnPrimary, inputCls } from "@/lib/ui";
import {
  FUNNEL_STAGES,
  STAGE_CONFIG,
  type Application,
  type ApplicationInterview,
  type ApplicationStage,
  type ApplicationStats,
  type ApplicationViewMode,
  type CalendarInterviewEvent,
  type InterviewRoundStatus,
} from "@/lib/applications-types";
import { jsonFetch } from "@/lib/fetcher";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useCompositionInput } from "@/hooks/use-composition-input";
import { ApplicationCard } from "@/components/application/application-card";
import { ApplicationDialog } from "@/components/application/application-dialog";
import { ApplicationInterviewRoundDialog } from "@/components/application/application-interview-round-dialog";
import { ApplicationViewSwitcher } from "@/components/application/application-view-switcher";
import { ApplicationCalendarView } from "@/components/application/calendar-view/application-calendar-view";
import { ApplicationFunnelView } from "@/components/application/funnel-view/application-funnel-view";
import { FunnelStrip } from "@/components/application/funnel-strip";
import { InterviewScheduleBanner } from "@/components/application/interview-schedule-banner";
import { errorMessage } from "@/lib/error-message";

export default function ApplicationsPage() {
  const [stats, setStats] = useState<ApplicationStats | null>(null);
  const [statsError, setStatsError] = useState("");
  const [keyword, setKeyword] = useState("");
  const { bind: keywordInputBind } = useCompositionInput("", setKeyword);
  const [selectedStage, setSelectedStage] = useState("all");
  const [showRejected, setShowRejected] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  // 视图模式: 看板 / 日程日历 / 全周期漏斗（惰性读取 URL 参数初始化）
  const [viewMode, setViewMode] = useState<ApplicationViewMode>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const urlView = params.get("view");
      if (urlView === "kanban" || urlView === "calendar" || urlView === "funnel") {
        return urlView;
      }
    }
    return "kanban";
  });

  // 对话框状态
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<Application | null>(null);
  const [defaultStage, setDefaultStage] = useState<ApplicationStage>("interested");
  const [stageOverride, setStageOverride] = useState<ApplicationStage>();
  const [initialInterviewDate, setInitialInterviewDate] = useState<Date>();

  // 面试轮次弹窗状态（供日历快捷编辑与添加）
  const [roundDialogOpen, setRoundDialogOpen] = useState(false);
  const [roundApp, setRoundApp] = useState<Application | null>(null);
  const [editingRound, setEditingRound] = useState<ApplicationInterview | null>(null);

  // 切换视图并同步 URL
  function handleViewChange(nextView: ApplicationViewMode) {
    setViewMode(nextView);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (nextView === "kanban") {
        url.searchParams.delete("view");
      } else {
        url.searchParams.set("view", nextView);
      }
      window.history.replaceState(null, "", url.toString());
    }
  }

  const statsLoadSeq = useRef(0);
  const mountedRef = useRef(true);

  const {
    items,
    nextCursor,
    loading,
    loadingMore,
    listError,
    failedCursor,
    loadMore: loadApplications,
    reload: reloadList,
  } = useCursorList<Application>({
    queryKey: `applications:${keyword.trim()}:${selectedStage}`,
    buildUrl: (cursor) => {
      const q = keyword.trim();
      const queryParts: string[] = [];
      if (q) queryParts.push(`q=${encodeURIComponent(q)}`);
      if (selectedStage !== "all") queryParts.push(`stage=${encodeURIComponent(selectedStage)}`);
      if (cursor) queryParts.push(`cursor=${encodeURIComponent(cursor)}`);
      return `/api/applications${queryParts.length > 0 ? `?${queryParts.join("&")}` : ""}`;
    },
  });

  useEffect(() => {
    if (viewMode === "calendar" && !loading && !loadingMore && nextCursor && !listError) {
      loadApplications();
    }
  }, [viewMode, loading, loadingMore, nextCursor, listError, loadApplications]);

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  async function loadStats() {
    const seq = ++statsLoadSeq.current;
    setStatsError("");
    try {
      const nextStats = await jsonFetch<ApplicationStats>("/api/applications/stats");
      if (seq !== statsLoadSeq.current || !mountedRef.current) return;
      setStats(nextStats);
      setStatsError("");
    } catch (err) {
      if (seq !== statsLoadSeq.current || !mountedRef.current) return;
      setStatsError(errorMessage(err));
    }
  }

  function refreshAfterMutation() {
    reloadList();
    void loadStats();
  }

  // 快捷创建
  function handleOpenCreate(stage: ApplicationStage = "interested", date?: Date) {
    setStageOverride(undefined);
    setEditingApp(null);
    setDefaultStage(stage);
    setInitialInterviewDate(date);
    setDialogOpen(true);
  }

  // 编辑卡片
  async function handleEdit(app: Application, override?: ApplicationStage) {
    try {
      // 列表刷新有防抖延迟；编辑前读取最新履历，避免刚保存就打开旧卡片。
      const latest = await jsonFetch<Application>(`/api/applications/${app.id}`);
      setStageOverride(override);
      setEditingApp(latest);
      setDialogOpen(true);
    } catch (err) {
      await alertDialog({ title: "加载投递失败", message: errorMessage(err) });
    }
  }

  // 删除卡片
  async function handleDelete(id: number) {
    try {
      await jsonFetch(`/api/applications/${id}`, { method: "DELETE" });
    } catch (err) {
      await alertDialog({ title: "删除失败", message: errorMessage(err) });
      return;
    }
    refreshAfterMutation();
  }

  // 阶段流转（支持点击推进或拖拽落地）
  async function handleStageChange(id: number, newStage: ApplicationStage) {
    if (newStage === "rejected") {
      const app = items?.find(item => item.id === id);
      if (!app) return;
      await handleEdit(app, "rejected");
      return;
    }
    try {
      await jsonFetch<Application>(`/api/applications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: newStage }),
      });
    } catch (err) {
      await alertDialog({ title: "流转失败", message: errorMessage(err) });
      return;
    }
    // 拖拽落地只改变看板列，没有可读反馈；这里播报一次结果
    const company = items?.find((app) => app.id === id)?.company;
    setAnnouncement(
      `${company ? `「${company}」` : "该投递"}已流转到${STAGE_CONFIG[newStage].label}阶段`
    );
    refreshAfterMutation();
  }

  // 拖拽操作支持
  function handleDragStart(e: React.DragEvent, id: number) {
    e.dataTransfer.setData("text/plain", String(id));
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent, targetStage: ApplicationStage) {
    e.preventDefault();
    const rawId = e.dataTransfer.getData("text/plain");
    const id = Number(rawId);
    if (Number.isInteger(id)) {
      void handleStageChange(id, targetStage);
    }
  }

  // 对话框保存成功回调
  function handleSaved() {
    setDialogOpen(false);
    refreshAfterMutation();
  }

  // 日历视图：点击编辑轮次
  function handleCalendarEditRound(event: CalendarInterviewEvent) {
    const parentApp = items?.find((a) => a.id === event.application_id);
    if (!parentApp) return;

    setRoundApp(parentApp);
    if (event.id > 0) {
      // 真实独立的 interview 轮次
      const existingRound = parentApp.interviews?.find((r) => r.id === event.id);
      setEditingRound(existingRound || null);
    } else {
      // 合成事件，新建轮次弹窗
      setEditingRound(null);
    }
    setRoundDialogOpen(true);
  }

  // 日历视图：快速标记轮次状态（如标记通过）
  async function handleQuickStatusChange(
    applicationId: number,
    roundId: number,
    status: InterviewRoundStatus
  ) {
    try {
      await jsonFetch(`/api/applications/${applicationId}/interviews/${roundId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      refreshAfterMutation();
    } catch (err) {
      await alertDialog({ title: "更新状态失败", message: errorMessage(err) });
    }
  }

  // 日历视图：在特定日期快速添加排期
  function handleCalendarAddSchedule(date: Date) {
    handleOpenCreate("interview", date);
  }

  // 轮次对话框保存后刷新
  function handleRoundSaved() {
    setRoundDialogOpen(false);
    refreshAfterMutation();
  }

  // 判断是否有 24 小时内的紧急待办面试（用于切换栏红点提示）
  const hasUrgentInterview = !!(
    stats?.upcomingInterviews &&
    stats.upcomingInterviews.some((app) => {
      const diff = new Date(app.next_interview_at).getTime() - Date.now();
      return diff >= 0 && diff <= 1000 * 60 * 60 * 24;
    })
  );

  // 按阶段拆分卡片集合
  const groupedApps: Record<ApplicationStage, Application[]> = {
    interested: [],
    applied: [],
    interviewing: [],
    interview: [],
    reviewing: [],
    offer: [],
    rejected: [],
  };

  if (items) {
    for (const app of items) {
      if (app.stage in groupedApps) {
        groupedApps[app.stage].push(app);
      }
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      {/* 顶部标题栏与全局操作 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            求职全景看板与日程
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            全周期漏斗转化、面试周日程追踪与简历/JD/模拟面试全景打通，掌控应聘全流程。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* 三大视图模式切换器 */}
          <ApplicationViewSwitcher
            currentView={viewMode}
            onViewChange={handleViewChange}
            activeCount={stats?.totalActive || 0}
            upcomingInterviewCount={stats?.upcomingInterviews?.length || 0}
            hasUrgentInterview={hasUrgentInterview}
            offerCount={stats?.counts?.offer || 0}
          />

          {/* 搜索框 */}
          <div className="relative">
            <input
              type="text"
              {...keywordInputBind}
              placeholder="搜索公司、岗位或笔记..."
              className={`${inputCls} w-48 sm:w-60 pl-8 py-1.5 text-xs bg-card`}
            />
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
                clipRule="evenodd"
              />
            </svg>
          </div>

          <button
            type="button"
            onClick={() => handleOpenCreate("interested")}
            className={btnPrimary}
          >
            <span aria-hidden className="font-bold">+</span>
            <span>登记新投递</span>
          </button>
        </div>
      </div>

      {/* 视图一：看板模式下的顶部辅助条 (漏斗简报与7天横幅) */}
      {viewMode === "kanban" && stats && (
        <FunnelStrip
          stats={stats}
          selectedStage={selectedStage}
          onSelectStage={setSelectedStage}
        />
      )}

      {/* 面试日程提示条 (若 7 天内有面试，在看板与漏斗模式中提示) */}
      {viewMode !== "calendar" &&
        stats?.upcomingInterviews &&
        stats.upcomingInterviews.length > 0 && (
          <InterviewScheduleBanner upcomingInterviews={stats.upcomingInterviews} />
        )}

      {statsError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-wash p-4 text-xs text-danger">
          <span>加载统计数据失败：{statsError}</span>
          <button type="button" className={btnPrimary} onClick={loadStats}>
            重试统计
          </button>
        </div>
      )}

      {/* 加载中与错误提示 */}
      {loading && <Loading label="正在加载求职数据..." />}
      {listError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger-wash p-4 text-xs text-danger">
          <span>加载投递数据失败：{listError}</span>
          {failedCursor === null && (
            <button
              type="button"
              className={btnPrimary}
              onClick={reloadList}
            >
              重试加载
            </button>
          )}
          {viewMode === "calendar" && failedCursor && (
            <button type="button" className={btnPrimary} onClick={loadApplications} disabled={loadingMore}>
              重试加载日程
            </button>
          )}
        </div>
      )}

      {/* 主工作区：根据 viewMode 渲染对应视图 */}
      {!loading && items !== null && (
        <>
          {/* 视图 1：看板列模式 (Kanban Board) */}
          {viewMode === "kanban" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 items-start">
                {FUNNEL_STAGES.map((stageKey) => {
                  const cfg = STAGE_CONFIG[stageKey];
                  const colApps = groupedApps[stageKey];

                  return (
                    <div
                      key={stageKey}
                      onDragOver={handleDragOver}
                      onDrop={(e) => handleDrop(e, stageKey)}
                      className={`flex flex-col rounded-2xl border ${cfg.border} bg-surface/50 p-3 min-h-[420px] transition-colors`}
                    >
                      {/* 列头部 */}
                      <div className="flex items-center justify-between border-b border-line pb-2.5 mb-3">
                        <div className="flex items-center gap-1.5">
                          <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot}`} />
                          <span className="font-serif text-sm font-bold text-ink">{cfg.label}</span>
                          <span className="rounded-full bg-card px-1.5 py-0.2 font-mono text-[11px] font-semibold text-muted border border-line">
                            {colApps.length}
                          </span>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleOpenCreate(stageKey)}
                          title={`快速在该列新建投递`}
                          className="rounded p-1 text-muted hover:bg-card hover:text-ink transition-colors"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                            <path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
                          </svg>
                        </button>
                      </div>

                      {/* 卡片列表 */}
                      <div className="flex-1 space-y-3">
                        {colApps.map((app) => (
                          <ApplicationCard
                            key={app.id}
                            application={app}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                            onStageChange={handleStageChange}
                            onDragStart={handleDragStart}
                            onRefresh={refreshAfterMutation}
                          />
                        ))}

                        {colApps.length === 0 && (
                          <div className="flex h-32 flex-col items-center justify-center rounded-xl border border-dashed border-line text-xs text-faint">
                            <span>暂无{cfg.label}卡片</span>
                            <button
                              type="button"
                              onClick={() => handleOpenCreate(stageKey)}
                              className="mt-1 text-primary hover:underline text-[11px]"
                            >
                              + 添加投递
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 流程终止分支 (折叠卡片区) */}
              <div className="rounded-2xl border border-line/60 bg-surface-2/40 p-4">
                <button
                  type="button"
                  onClick={() => setShowRejected((v) => !v)}
                  className="flex w-full items-center justify-between text-left text-xs font-medium text-muted hover:text-ink"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-faint" />
                    <span className="font-serif text-sm font-bold text-muted">
                      流程终止 / 不合适 ({groupedApps.rejected.length})
                    </span>
                    <span className="text-[11px] text-faint">
                      仅存放已确认结束的投递；暂未推进仍保留在当前阶段
                    </span>
                  </div>
                  <span>{showRejected ? "▲ 收起" : "▼ 展开查看"}</span>
                </button>

                {showRejected && (
                  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 pt-3 border-t border-line/50">
                    {groupedApps.rejected.map((app) => (
                      <ApplicationCard
                        key={app.id}
                        application={app}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onStageChange={handleStageChange}
                        onDragStart={handleDragStart}
                      />
                    ))}
                    {groupedApps.rejected.length === 0 && (
                      <div className="col-span-full py-6 text-center text-xs text-faint">
                        暂无流程终止的投递记录
                      </div>
                    )}
                  </div>
                )}
              </div>

              {nextCursor && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    className={btnPrimary}
                    onClick={loadApplications}
                    disabled={loadingMore}
                  >
                    {loadingMore
                      ? "正在加载"
                      : failedCursor === nextCursor
                        ? "重试加载更多"
                        : "加载更多"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 视图 2：日历日程模式 (Calendar & Agenda View) */}
          {viewMode === "calendar" && nextCursor && !listError && (
            <Loading label="正在加载完整日程..." />
          )}
          {viewMode === "calendar" && listError && (
            <p className="text-sm text-muted">日程尚未完整加载，请重试后查看或导出。</p>
          )}
          {viewMode === "calendar" && !nextCursor && !listError && (
            <ApplicationCalendarView
              applications={items}
              onEditRound={handleCalendarEditRound}
              onQuickStatusChange={handleQuickStatusChange}
              onQuickAddSchedule={handleCalendarAddSchedule}
            />
          )}

          {/* 视图 3：全周期漏斗分析模式 (Full Lifecycle Funnel) */}
          {viewMode === "funnel" && stats?.funnel && (
            <ApplicationFunnelView metrics={stats.funnel} batches={stats.batchStats ?? []} />
          )}
        </>
      )}

      {/* 弹窗创建/编辑投递 */}
      {dialogOpen && (
        <ApplicationDialog
          initialData={editingApp}
          defaultStage={defaultStage}
            initialInterviewDate={editingApp ? undefined : initialInterviewDate}
          stageOverride={stageOverride}
          onClose={() => setDialogOpen(false)}
          onSuccess={handleSaved}
        />
      )}

      {/* 弹窗创建/编辑单场面试轮次（日历联动） */}
      {roundDialogOpen && roundApp && (
        <ApplicationInterviewRoundDialog
          application={roundApp}
          initialInterview={editingRound}
          open={roundDialogOpen}
          onClose={() => setRoundDialogOpen(false)}
          onSuccess={handleRoundSaved}
        />
      )}

      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
