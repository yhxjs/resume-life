"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  STAGE_CONFIG,
  FUNNEL_STAGES,
  ROUND_STATUS_CONFIG,
  APPLICATION_TERMINAL_STAGE_CONFIG,
  type Application,
  type ApplicationInterview,
  type ApplicationStage,
} from "@/lib/applications-types";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { Modal } from "@/components/common/modal";
import { ApplicationInterviewRoundDialog } from "@/components/application/application-interview-round-dialog";
import { ApplicationVersionsDialog } from "@/components/application/application-versions-dialog";
import { formatFriendlyDateTime } from "@/lib/application-datetime";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";

interface ApplicationCardProps {
  application: Application;
  onEdit: (app: Application) => void;
  onDelete: (id: number) => void;
  onStageChange: (id: number, stage: ApplicationStage) => void;
  onDragStart?: (e: React.DragEvent, id: number) => void;
  onRefresh?: () => void;
}

function formatInterviewNotice(nextInterviewAt: string, currentTimestamp: number): { text: string; isUrgent: boolean } | null {
  if (!nextInterviewAt) return null;
  try {
    const interviewDate = new Date(nextInterviewAt);
    const diffMs = interviewDate.getTime() - currentTimestamp;
    const diffHours = Math.round(diffMs / (1000 * 60 * 60));
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    const timeStr = `${interviewDate.getMonth() + 1}/${interviewDate.getDate()} ${String(
      interviewDate.getHours()
    ).padStart(2, "0")}:${String(interviewDate.getMinutes()).padStart(2, "0")}`;

    if (diffMs < 0) {
      return {
        text: `面试已过 · ${timeStr}`,
        isUrgent: false,
      };
    } else if (diffHours <= 24) {
      return {
        text: `今日/明晨待面 · ${timeStr} (${diffHours}h后)`,
        isUrgent: true,
      };
    } else if (diffDays <= 3) {
      return {
        text: `即将待面 · ${timeStr} (${diffDays}天后)`,
        isUrgent: true,
      };
    } else {
      return {
        text: `约定面试 · ${timeStr}`,
        isUrgent: false,
      };
    }
  } catch {
    return null;
  }
}

export function ApplicationCard({
  application: app,
  onEdit,
  onDelete,
  onStageChange,
  onDragStart,
  onRefresh,
}: ApplicationCardProps) {
  const [showJdModal, setShowJdModal] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [roundDialogOpen, setRoundDialogOpen] = useState(false);
  const [editingRound, setEditingRound] = useState<ApplicationInterview | null>(null);

  useEffect(() => {
    // 挂载后记录当前时间戳，避免 SSR/Pure Render 阶段调用 Date.now()
    const timer = setTimeout(() => setCurrentTime(Date.now()), 0);
    return () => clearTimeout(timer);
  }, []);

  const interviewNotice = currentTime ? formatInterviewNotice(app.next_interview_at, currentTime) : null;

  // 快捷前进与后退
  const stageOrder: ApplicationStage[] = [...FUNNEL_STAGES, "rejected"];
  const curIdx = stageOrder.indexOf(app.stage);
  const prevStage = curIdx > 0 ? stageOrder[curIdx - 1] : null;
  const nextStage = curIdx >= 0 && curIdx < FUNNEL_STAGES.length - 1 ? stageOrder[curIdx + 1] : null;

  async function handleDelete() {
    const ok = await confirmDialog({
      title: "确认删除投递记录？",
      message: `确定要删除【${app.company} · ${app.role}】的投递卡片吗？此操作不可恢复。`,
      confirmText: "确认删除",
      danger: true,
    });
    if (ok) {
      onDelete(app.id);
    }
  }

  function handleOpenAddRound() {
    setEditingRound(null);
    setRoundDialogOpen(true);
  }

  function handleOpenEditRound(round: ApplicationInterview) {
    setEditingRound(round);
    setRoundDialogOpen(true);
  }

  return (
    <>
      <div
        draggable
        onDragStart={(e) => onDragStart?.(e, app.id)}
        className="group relative flex flex-col rounded-xl border border-line bg-card p-3.5 shadow-xs transition-all duration-150 hover:border-line-strong hover:shadow-card-subtle cursor-grab active:cursor-grabbing"
      >
        {/* 顶部：公司与岗位 */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-serif text-base font-bold text-ink truncate leading-tight group-hover:text-primary transition-colors">
              {app.company}
            </h3>
            <p className="text-xs font-medium text-muted truncate mt-0.5">{app.role}</p>
          </div>

          {/* 右上角操作按键 */}
          <div className="flex items-center gap-1 opacity-80 sm:opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => onEdit(app)}
              title="编辑卡片"
              className="rounded p-1 text-muted hover:bg-surface hover:text-ink transition-colors"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path d="m5.433 13.917 1.262-3.155A4 4 0 0 1 7.58 9.42l6.92-6.918a2.121 2.121 0 0 1 3 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 0 1-.65-.65Z" />
                <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0 0 10 3H4.75A2.75 2.75 0 0 0 2 5.75v9.5A2.75 2.75 0 0 0 4.75 18h9.5A2.75 2.75 0 0 0 17 15.25V10a.75.75 0 0 0-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5Z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleDelete}
              title="删除卡片"
              className="rounded p-1 text-muted hover:bg-danger-wash hover:text-danger transition-colors"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                <path
                  fillRule="evenodd"
                  d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 0 0 1.5.06l.3-7.5Z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* 薪资范围徽标 */}
        {app.salary_range && (
          <div className="mt-2 flex items-center gap-1.5">
            <span className="inline-flex items-center rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-mono text-muted">
              {app.salary_range}
            </span>
          </div>
        )}

        {/* 面试日程提醒条 */}
        {interviewNotice && (
          <div
            className={`mt-2.5 flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium ${
              interviewNotice.isUrgent
                ? "border-accent/40 bg-accent/10 text-accent font-semibold"
                : "border-line bg-surface text-muted"
            }`}
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-3.5 h-3.5 shrink-0 ${interviewNotice.isUrgent ? "text-accent" : "text-muted"}`}
            >
              <path
                fillRule="evenodd"
                d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z"
                clipRule="evenodd"
              />
            </svg>
            <span className="truncate">{interviewNotice.text}</span>
          </div>
        )}

        {/* 独立面试轮次记录条 (一面、二面、HR面等) */}
        <div className="mt-2.5 rounded-lg border border-line/70 bg-surface/70 p-2">
          <div className="flex items-center justify-between gap-1 text-[11px] mb-1.5">
            <span className="font-semibold text-muted flex items-center gap-1">
              <span>🎯</span>
              <span>面试进度</span>
              {app.interviews && app.interviews.length > 0 && (
                <span className="text-faint font-mono">({app.interviews.length}轮)</span>
              )}
            </span>
            <button
              type="button"
              onClick={handleOpenAddRound}
              className="text-primary hover:underline text-[11px] font-medium flex items-center gap-0.5"
              title="添加新面试轮次"
            >
              <span>+ 记面试</span>
            </button>
          </div>

          {app.interviews && app.interviews.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {app.interviews.map((round) => {
                const statusCfg = ROUND_STATUS_CONFIG[round.status] || ROUND_STATUS_CONFIG.scheduled;
                return (
                  <button
                    key={round.id}
                    type="button"
                    onClick={() => handleOpenEditRound(round)}
                    title={`点击修改：${round.round_name} · ${statusCfg.label}${round.interview_time ? ` · ${formatFriendlyDateTime(round.interview_time)}` : ""}${round.interviewer ? ` (${round.interviewer})` : ""}`}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors hover:shadow-xs ${statusCfg.bg} ${statusCfg.color} ${statusCfg.border}`}
                  >
                    <span>{round.round_name}</span>
                    <span className="text-[10px] opacity-80">({statusCfg.label})</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center justify-between text-[11px] text-faint">
              <span>暂无面试轮次</span>
              <button
                type="button"
                onClick={handleOpenAddRound}
                className="text-muted hover:text-primary transition-colors text-[10px]"
              >
                登记一面
              </button>
            </div>
          )}
        </div>

        {/* 关联资产药丸徽章 */}
        <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
          {/* 关联简历 */}
          {app.resume_id && app.resume_title ? (
            <Link
              href={app.resume_version_id ? `/resumes/${app.resume_id}/versions?version=${app.resume_version_id}` : `/resumes/${app.resume_id}`}
              title={`查看关联简历版本：${app.resume_title}`}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-muted hover:border-primary hover:text-primary transition-colors truncate max-w-[160px]"
            >
              <span aria-hidden>📄</span>
              <span className="truncate">{app.resume_title}</span>
            </Link>
          ) : (
            <span className="inline-flex items-center rounded-md border border-dashed border-line px-1.5 py-0.5 text-faint text-[10px]">
              未绑定简历
            </span>
          )}

          <ResumeVersionBadge {...app} />
          <button type="button" onClick={() => setShowVersions(true)}
            className="inline-flex items-center rounded-md border border-line bg-card px-2 py-0.5 text-muted transition-colors hover:border-primary hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
            投递版 / 对比
          </button>

          {/* 关联 JD */}
          {app.jd ? (
            <button
              type="button"
              onClick={() => setShowJdModal(true)}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-card px-2 py-0.5 text-muted hover:border-primary hover:text-primary transition-colors"
            >
              <span aria-hidden>📋</span>
              <span>查看 JD</span>
            </button>
          ) : null}

          {/* 关联模拟面试 */}
          {app.interview_id ? (
            <Link
              href={`/interviews/${app.interview_id}`}
              className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-primary hover:bg-primary/10 transition-colors"
              title="点击跳转单轮模拟面试复盘"
            >
              <span aria-hidden>🎯</span>
              <span>
                模考 #{app.interview_id}
                {app.interview_rounds ? ` (${app.interview_rounds}题)` : ""}
              </span>
            </Link>
          ) : app.interview_series_id ? (
            <Link
              href={`/interviews/series/${app.interview_series_id}`}
              className="inline-flex items-center gap-1 rounded-md border border-accent/20 bg-accent/5 px-2 py-0.5 text-accent hover:bg-accent/10 transition-colors"
              title="点击跳转进阶三轮模拟面试"
            >
              <span aria-hidden>🏆</span>
              <span>进阶模考 #{app.interview_series_id}</span>
            </Link>
          ) : null}
        </div>

        {/* 备忘随笔摘要 */}
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <span>{app.stage === "rejected" ? "已终止" : app.stage === "offer" ? "已通过" : "进行中"}</span>
          {app.batch_name && <span className="break-all">批次：{app.batch_name}</span>}
          {app.hiring_stage && <span>{APPLICATION_TERMINAL_STAGE_CONFIG[app.hiring_stage].label}</span>}
        </div>
        {app.stage === "rejected" && <p className="mt-1 break-words text-xs text-muted">终止原因：{app.terminal_reason || "历史记录，待补充"}</p>}

        {app.notes && (
          <p className="mt-2.5 rounded-lg bg-surface-2/60 p-2 text-xs leading-relaxed text-muted line-clamp-2 border border-line/40">
            {app.notes}
          </p>
        )}

        {/* 底部：快速阶段推进与流转控制 */}
        <Link href={`/applications/${app.id}/prepare`} className="mt-3 inline-flex items-center justify-between rounded-lg bg-primary-soft px-3 py-2 text-sm font-semibold text-primary transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary">
          投递准备 <span aria-hidden>→</span>
        </Link>
        <div className="mt-3.5 flex items-center justify-between border-t border-line/70 pt-2.5 text-xs">
          <span className="text-[11px] text-faint">
            {new Date(app.updated_at).toLocaleDateString()}
          </span>

          <div className="flex items-center gap-1">
            {prevStage && (
              <button
                type="button"
                onClick={() => onStageChange(app.id, prevStage)}
                title={`回退至：${STAGE_CONFIG[prevStage].label}`}
                className="rounded px-1.5 py-0.5 text-muted hover:bg-surface hover:text-ink transition-colors"
              >
                ←
              </button>
            )}

            {/* 快速选择阶段 */}
            <select
              aria-label="流转阶段"
              value={app.stage}
              onChange={(e) => onStageChange(app.id, e.target.value as ApplicationStage)}
              className="rounded border border-line bg-card px-1.5 py-0.5 text-xs text-ink font-medium hover:border-line-strong transition-colors cursor-pointer"
            >
              {(Object.keys(STAGE_CONFIG) as ApplicationStage[]).map((st) => (
                <option key={st} value={st}>
                  {STAGE_CONFIG[st].label}
                </option>
              ))}
            </select>

            {nextStage && (
              <button
                type="button"
                onClick={() => onStageChange(app.id, nextStage)}
                title={`推进至：${STAGE_CONFIG[nextStage].label}`}
                className="rounded px-1.5 py-0.5 text-primary font-bold hover:bg-primary-soft transition-colors"
              >
                →
              </button>
            )}
          </div>
        </div>
      </div>

      {showVersions && <ApplicationVersionsDialog application={app} onClose={() => setShowVersions(false)} />}

      {/* JD 查看模态窗 */}
      <Modal
        open={showJdModal}
        onClose={() => setShowJdModal(false)}
        title={`${app.company} · ${app.role} JD`}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-line pb-3">
            <div>
              <h3 className="font-serif text-base font-bold text-ink">
                {app.company} · {app.role} JD
              </h3>
              <span className="text-xs text-muted">岗位职位描述与能力要求</span>
            </div>
            <button
              type="button"
              onClick={() => setShowJdModal(false)}
              aria-label="关闭 JD 查看"
              className="text-muted hover:text-ink p-1"
            >
              ✕
            </button>
          </div>

          <div className="max-h-[55dvh] overflow-y-auto rounded-lg bg-surface p-3.5 border border-line/60 font-mono text-xs leading-relaxed text-ink whitespace-pre-wrap">
            {app.jd}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-line">
            <Link
              href={`/interviews?applicationId=${app.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:bg-primary-hover shadow-xs"
            >
              <span>以此 JD 发起模拟面试</span>
              <span aria-hidden>→</span>
            </Link>
            <button
              type="button"
              onClick={() => setShowJdModal(false)}
              className="rounded-lg border border-line px-3 py-1.5 text-xs text-muted hover:text-ink"
            >
              关闭
            </button>
          </div>
        </div>
      </Modal>

      {/* 面试轮次新增/编辑弹窗 */}
      {roundDialogOpen && (
        <ApplicationInterviewRoundDialog
          application={app}
          initialInterview={editingRound}
          open={roundDialogOpen}
          onClose={() => {
            setRoundDialogOpen(false);
            setEditingRound(null);
          }}
          onSuccess={() => {
            onRefresh?.();
          }}
        />
      )}
    </>
  );
}
