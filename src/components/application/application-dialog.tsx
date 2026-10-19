"use client";

import { useId, useState } from "react";
import { InlineError } from "@/components/common/inline-error";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { modalOverlayCls, dialogCardCls, btnPrimary, btnGhost, inputCls, textareaCls, textareaShortCls, labelCls } from "@/lib/ui";
import { STAGE_CONFIG, ROUND_STATUS_CONFIG, type Application, type ApplicationStage, type CreateApplicationInput } from "@/lib/applications-types";
import { jsonFetch } from "@/lib/fetcher";
import { formatFriendlyDateTime, fromLocalDateTime, toLocalDateTime } from "@/lib/application-datetime";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { useCursorList } from "@/hooks/use-cursor-list";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { errorMessage } from "@/lib/error-message";
import { DateTimePicker } from "@/components/common/date-time-picker";
import { APPLICATION_TERMINAL_STAGES, APPLICATION_TERMINAL_STAGE_CONFIG, type ApplicationTerminalStage } from "@/lib/applications-types";

interface InterviewOption {
  id: number;
  jd: string;
  created_at: string;
  answered: number;
  rounds: number;
}

interface SeriesOption {
  id: number;
  jd: string;
  created_at: string;
  rounds_done: number;
  rounds_total: number;
}

interface ApplicationDialogProps {
  initialData?: Application | null;
  defaultStage?: ApplicationStage;
  stageOverride?: ApplicationStage;
  initialInterviewDate?: Date;
  onClose: () => void;
  onSuccess: (saved: Application) => void;
}

export function ApplicationDialog({
  initialData,
  defaultStage = "interested",
  stageOverride,
  initialInterviewDate,
  onClose,
  onSuccess,
}: ApplicationDialogProps) {
  const isEdit = Boolean(initialData);
  const formId = useId();
  const dialogRef = useModalFocus(true, onClose, '[data-initial-focus]');

  const [company, setCompany] = useState(initialData?.company ?? "");
  const [role, setRole] = useState(initialData?.role ?? "");
  const [salaryRange, setSalaryRange] = useState(initialData?.salary_range ?? "");
  const [stage, setStage] = useState<ApplicationStage>(stageOverride ?? initialData?.stage ?? defaultStage);
  const [batchName, setBatchName] = useState(initialData?.batch_name ?? "");
  const [hiringStage, setHiringStage] = useState<ApplicationTerminalStage | "">(initialData?.hiring_stage ?? "");
  const [terminalStage, setTerminalStage] = useState<ApplicationTerminalStage | "">(initialData?.terminal_stage ?? initialData?.hiring_stage ?? "");
  const [terminalReason, setTerminalReason] = useState(initialData?.terminal_reason ?? "");
  const requireTermination = stage === "rejected";
  const [resumeId, setResumeId] = useState<string>(
    initialData?.resume_id ? String(initialData.resume_id) : ""
  );
  const [jd, setJd] = useState(initialData?.jd ?? "");
  const [interviewId, setInterviewId] = useState<string>(
    initialData?.interview_id ? String(initialData.interview_id) : ""
  );
  const [interviewSeriesId, setInterviewSeriesId] = useState<string>(
    initialData?.interview_series_id ? String(initialData.interview_series_id) : ""
  );
  const [nextInterviewAt, setNextInterviewAt] = useState(
    toLocalDateTime(initialData?.next_interview_at ?? "")
  );
  const [notes, setNotes] = useState(initialData?.notes ?? "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [optionsReloadVersion, setOptionsReloadVersion] = useState(0);

  const interviewOptions = useCursorList<InterviewOption>({
    queryKey: "application-interview-options",
    buildUrl: (cursor) => `/api/interviews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const seriesOptions = useCursorList<SeriesOption>({
    queryKey: "application-series-options",
    buildUrl: (cursor) => `/api/interviews/series${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const interviews = interviewOptions.items ?? [];
  const series = seriesOptions.items ?? [];

  const { resumes, resumesError } = useResumeOptions(optionsReloadVersion);
  const selectedResume = resumes?.find((resume) => String(resume.id) === resumeId);
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(
    selectedResume,
    initialData?.resume_id === Number(resumeId) ? initialData.resume_version_id : null,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) {
      setError("公司名称不能为空");
      return;
    }
    if (!role.trim()) {
      setError("岗位名称不能为空");
      return;
    }
    if (resumeId && !resumeVersionId) {
      setError("请选择已发布的简历版本；尚未发布时，请先到简历编辑器发布。");
      return;
    }

    if (requireTermination && (!terminalStage || !terminalReason.trim())) {
      setError("请选择终止阶段并填写终止原因");
      return;
    }
    setSaving(true);
    setError("");

    try {
      const payload: CreateApplicationInput = {
        company: company.trim(),
        role: role.trim(),
        salary_range: salaryRange.trim(),
        stage,
        batch_name: batchName.trim(),
        hiring_stage: hiringStage || (stage === "applied" ? "resume_screening" : null),
        ...(requireTermination ? { terminal_stage: terminalStage as ApplicationTerminalStage, terminal_reason: terminalReason.trim() } : {}),
        resume_id: resumeId ? Number(resumeId) : null,
        resume_version_id: resumeId && resumeVersionId ? resumeVersionId : null,
        jd: jd.trim(),
        interview_id: interviewId ? Number(interviewId) : null,
        interview_series_id: interviewSeriesId ? Number(interviewSeriesId) : null,
        next_interview_at: fromLocalDateTime(nextInterviewAt, initialData?.next_interview_at),
        notes: notes.trim(),
      };

      let saved: Application;
      if (isEdit && initialData) {
        saved = await jsonFetch<Application>(`/api/applications/${initialData.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        saved = await jsonFetch<Application>("/api/applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      onSuccess(saved);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div ref={dialogRef} tabIndex={-1} className={modalOverlayCls} onClick={onClose} role="dialog" aria-modal="true" aria-labelledby={`${formId}-title`}>
      <div
        className={`relative ${dialogCardCls} max-w-2xl w-full max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <LoadingOverlay
          show={saving}
          message={isEdit ? "正在保存投递修改…" : "正在创建投递记录…"}
          description="正在持久化投递档案与关联备战资料，请稍候…"
        />
        <div className="flex items-center justify-between border-b border-line pb-3.5">
          <h2 id={`${formId}-title`} className="font-serif text-lg font-bold text-ink">
            {isEdit ? "编辑求职投递卡片" : "新建求职投递"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink transition-colors p-1"
            aria-label="关闭弹窗"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-danger/30 bg-danger-wash p-3 text-xs text-danger">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-sm">
          {/* 公司名称与岗位 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${formId}-company`} className={labelCls}>
                公司名称 <span className="text-danger">*</span>
              </label>
              <input
                id={`${formId}-company`}
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="如：字节跳动、阿里巴巴"
                className={inputCls}
                data-initial-focus
                required
              />
            </div>
            <div>
              <label htmlFor={`${formId}-role`} className={labelCls}>
                目标岗位 <span className="text-danger">*</span>
              </label>
              <input
                id={`${formId}-role`}
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="如：资深前端架构师"
                className={inputCls}
                required
              />
            </div>
          </div>

          {/* 阶段选择与薪资 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${formId}-stage`} className={labelCls}>当前阶段</label>
              <select
                id={`${formId}-stage`}
                value={stage}
                onChange={(e) => {
                  const next = e.target.value as ApplicationStage;
                  setStage(next);
                  if (next === "applied") setHiringStage("resume_screening");
                  else if (next === "interested" || (next !== "rejected" && hiringStage === "resume_screening")) setHiringStage("");
                  if (next === "rejected" && !terminalStage) setTerminalStage(hiringStage);
                }}
                className={inputCls}
              >
                {(Object.keys(STAGE_CONFIG) as ApplicationStage[]).map((st) => (
                  <option key={st} value={st}>
                    {STAGE_CONFIG[st].label} ({STAGE_CONFIG[st].desc})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${formId}-salary`} className={labelCls}>薪资范围 / 待遇待遇期望</label>
              <input
                id={`${formId}-salary`}
                type="text"
                value={salaryRange}
                onChange={(e) => setSalaryRange(e.target.value)}
                placeholder="如：25k-35k · 16薪"
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${formId}-batch`} className={labelCls}>投递批次</label>
              <input id={`${formId}-batch`} value={batchName} onChange={e => setBatchName(e.target.value)}
                className={inputCls} maxLength={100} placeholder="如：春招第一批、简历 V2" />
              <p className="mt-1 text-xs text-muted">同名批次一起统计；留空归为未分批。</p>
            </div>
            {stage !== "rejected" && (
              <div>
                <label htmlFor={`${formId}-hiring-stage`} className={labelCls}>当前招聘环节</label>
                <select id={`${formId}-hiring-stage`} value={hiringStage} onChange={e => setHiringStage(e.target.value as ApplicationTerminalStage | "")} className={inputCls}>
                  <option value="">{stage === "applied" ? "简历筛选（投递后默认）" : "尚未确定"}</option>
                  {APPLICATION_TERMINAL_STAGES.map(s => <option key={s} value={s}>{APPLICATION_TERMINAL_STAGE_CONFIG[s].label}</option>)}
                </select>
                <p className="mt-1 text-xs text-muted">进入后续环节表示前一环节已通过；等待结果时保留当前环节。</p>
              </div>
            )}
          </div>
          {stage === "rejected" && (
            <fieldset className="space-y-3 rounded-xl border border-line p-3">
              <legend className="px-1 text-sm font-medium text-ink">已终止 · 记录归因</legend>
              <p className="text-xs text-muted">只有确认结束的流程才标记终止；暂未回应或等待安排仍属于进行中。</p>
              <div>
                <label htmlFor={`${formId}-terminal-stage`} className={labelCls}>终止阶段{requireTermination ? " *" : ""}</label>
                <select id={`${formId}-terminal-stage`} value={terminalStage} onChange={e => setTerminalStage(e.target.value as ApplicationTerminalStage | "")} className={inputCls} required={requireTermination}>
                  <option value="">请选择终止阶段</option>
                  {APPLICATION_TERMINAL_STAGES.map(s => <option key={s} value={s}>{APPLICATION_TERMINAL_STAGE_CONFIG[s].label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`${formId}-terminal-reason`} className={labelCls}>终止原因{requireTermination ? " *" : ""}</label>
                <textarea id={`${formId}-terminal-reason`} value={terminalReason} onChange={e => setTerminalReason(e.target.value)}
                  required={requireTermination} maxLength={1000} className={textareaShortCls} placeholder="如：技术面未通过、薪资未谈拢、主动退出" />
              </div>
            </fieldset>
          )}
          {!!initialData?.stage_history?.length && (
            <details className="rounded-xl border border-line p-3">
              <summary className="cursor-pointer text-sm font-medium text-ink">阶段履历（{initialData.stage_history.length} 条）</summary>
              <ol className="mt-3 space-y-3 text-xs">
                {initialData.stage_history.map(entry => (
                  <li key={entry.id} className="border-l-2 border-line pl-3">
                    <p className="text-ink">{entry.from_stage ? STAGE_CONFIG[entry.from_stage].label : "开始记录"} → {STAGE_CONFIG[entry.to_stage].label}
                      {entry.to_hiring_stage && ` · ${APPLICATION_TERMINAL_STAGE_CONFIG[entry.to_hiring_stage].label}`}
                    </p>
                    <p className="mt-0.5 text-muted">{entry.changed_at ? formatFriendlyDateTime(entry.changed_at) : "历史记录，阶段时间未知"}</p>
                    {entry.reason && <p className="mt-1 break-words text-muted">{entry.reason}</p>}
                  </li>
                ))}
              </ol>
            </details>
          )}

          {/* 关联简历与面试日程 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${formId}-resume`} className={labelCls}>关联简历</label>
              <select
                id={`${formId}-resume`}
                value={resumeId}
                disabled={saving}
                onChange={(e) => setResumeId(e.target.value)}
                className={inputCls}
              >
                <option value="">-- 未关联简历 --</option>
                {(resumes ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span id={`${formId}-time-label`} className={labelCls}>下次面试时间 (约面/待面)</span>
              <DateTimePicker
                id={`${formId}-time`}
                ariaLabelledBy={`${formId}-time-label`}
                value={nextInterviewAt}
                initialDate={initialInterviewDate}
                onChange={setNextInterviewAt}
                placeholder="选择下次面试时间..."
              />
            </div>
          </div>

          <ResumeVersionSelect resume={selectedResume} value={resumeVersionId} onChange={setResumeVersionId} disabled={saving} />

          <p className="text-xs leading-relaxed text-muted">
            {initialData?.submitted_at
              ? "已保存固定投递版。这里的简历与 JD 修改只影响当前版，不会覆盖投递版。"
              : initialData?.stage === "applied"
                ? "投递快照缺失，无法还原当时内容。"
                : "首次标记为「已投递」时，会保存所选简历发布版本与本次 JD，之后不再覆盖。"}
            {!initialData?.submitted_at && stage === "applied" && !resumeId && " 当前未关联简历，仅保存 JD；稍后关联不会补入投递版。"}
          </p>

          {/* 关联模拟面试记录 */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${formId}-interview`} className={labelCls}>关联单轮模拟面试</label>
              <select
                id={`${formId}-interview`}
                value={interviewId}
                onChange={(e) => {
                  setInterviewId(e.target.value);
                  if (e.target.value) setInterviewSeriesId("");
                }}
                className={inputCls}
              >
                <option value="">-- 未关联单轮模考 --</option>
                {interviewId && !interviews.some((item) => String(item.id) === interviewId) && (
                  <option value={interviewId}>#{interviewId} · 当前关联的单轮面试</option>
                )}
                {interviews.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    #{inv.id} · {inv.jd.slice(0, 20)} ({inv.answered}/{inv.rounds}题)
                  </option>
                ))}
              </select>
              {interviewOptions.loading && <p role="status" className="mt-1 text-xs text-muted">正在加载单轮面试...</p>}
              {interviewOptions.listError && <p role="alert" className="mt-1 text-xs text-danger">单轮面试候选加载失败：{interviewOptions.listError}</p>}
              {(interviewOptions.hasMore || interviewOptions.listError) && (
                <button type="button" className={btnGhost} disabled={interviewOptions.loadingMore}
                  onClick={interviewOptions.failedCursor === null ? interviewOptions.reload : interviewOptions.loadMore}>
                  {interviewOptions.loadingMore ? "正在加载单轮面试..." : interviewOptions.listError ? "重试加载单轮面试" : "加载更多单轮面试"}
                </button>
              )}
            </div>
            <div>
              <label htmlFor={`${formId}-series`} className={labelCls}>或 关联进阶多轮面试</label>
              <select
                id={`${formId}-series`}
                value={interviewSeriesId}
                onChange={(e) => {
                  setInterviewSeriesId(e.target.value);
                  if (e.target.value) setInterviewId("");
                }}
                className={inputCls}
              >
                <option value="">-- 未关联进阶连打 --</option>
                {interviewSeriesId && !series.some((item) => String(item.id) === interviewSeriesId) && (
                  <option value={interviewSeriesId}>#{interviewSeriesId} · 当前关联的多轮面试</option>
                )}
                {series.map((s) => (
                  <option key={s.id} value={s.id}>
                    #{s.id} · {s.jd.slice(0, 20)} ({s.rounds_done}/{s.rounds_total}轮)
                  </option>
                ))}
              </select>
              {seriesOptions.loading && <p role="status" className="mt-1 text-xs text-muted">正在加载多轮面试...</p>}
              {seriesOptions.listError && <p role="alert" className="mt-1 text-xs text-danger">多轮面试候选加载失败：{seriesOptions.listError}</p>}
              {(seriesOptions.hasMore || seriesOptions.listError) && (
                <button type="button" className={btnGhost} disabled={seriesOptions.loadingMore}
                  onClick={seriesOptions.failedCursor === null ? seriesOptions.reload : seriesOptions.loadMore}>
                  {seriesOptions.loadingMore ? "正在加载多轮面试..." : seriesOptions.listError ? "重试加载多轮面试" : "加载更多多轮面试"}
                </button>
              )}
            </div>
          </div>

          {/* 若为编辑态且已有真实面试轮次记录，展示轮次列表提示 */}
          {isEdit && initialData?.interviews && initialData.interviews.length > 0 && (
            <div className="rounded-lg border border-line/70 bg-surface/70 p-3">
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="font-semibold text-ink flex items-center gap-1.5">
                  <span>🎯</span>
                  <span>已登记真实面试轮次 ({initialData.interviews.length} 轮)</span>
                </span>
                <span className="text-[11px] text-muted">可在看板卡片上直接点击或新增轮次</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {initialData.interviews.map((r) => {
                  const cfg = ROUND_STATUS_CONFIG[r.status] || ROUND_STATUS_CONFIG.scheduled;
                  return (
                    <span
                      key={r.id}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.color} ${cfg.border}`}
                    >
                      <span>{r.round_name}</span>
                      <span className="text-[10px] opacity-80">({cfg.label})</span>
                      {r.interview_time && <span className="text-[10px] font-mono opacity-80">· {formatFriendlyDateTime(r.interview_time)}</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {resumesError && (
            <InlineError
              message={`简历候选加载失败：${resumesError}`}
              onRetry={() => setOptionsReloadVersion((version) => version + 1)}
            />
          )}

          {/* 岗位 JD */}
          <div>
            <div className="flex items-center justify-between">
              <label htmlFor={`${formId}-jd`} className={labelCls}>岗位 JD / 职位要求</label>
              <span className="text-[11px] text-faint">用于复习、针对性模考与考点画像</span>
            </div>
            <textarea
              id={`${formId}-jd`}
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              placeholder="可直接粘贴招聘网站上的详细职位描述与任职要求..."
              className={`${textareaCls} font-mono text-xs`}
            />
          </div>

          {/* 备注 / 面试手记 */}
          <div>
            <label htmlFor={`${formId}-notes`} className={labelCls}>投递备注 / 面试要点手记</label>
            <textarea
              id={`${formId}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="如：猎头微信、面试官提问侧重点、复盘短板、薪资期望..."
              className={textareaShortCls}
            />
          </div>

          {/* 操作按钮栏 */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-line">
            <button type="button" onClick={onClose} disabled={saving} className={btnGhost}>
              取消
            </button>
            <button type="submit" disabled={saving || Boolean(resumeId && !resumeVersionId)} className={btnPrimary}>
              {saving ? "正在保存..." : isEdit ? "更新卡片" : "立即创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
