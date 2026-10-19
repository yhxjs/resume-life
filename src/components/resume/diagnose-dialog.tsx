"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  DIMENSIONS,
} from "@/lib/scores";
import type {
  DiagnosisField,
  DiagnosisHistoryResponse,
  DiagnosisSuggestion,
} from "@/lib/diagnosis";
import { diagnosisValue } from "@/lib/diagnosis";
import type { ModuleData } from "@/lib/modules";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
import { DiagnosisChanges } from "@/components/resume/diagnosis-changes";
import { getResumeSaveQueue } from "@/lib/resume-save-queue";
import { resumeToMarkdown } from "@/lib/resume-markdown";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { jsonFetch } from "@/lib/fetcher";
import {
  badgeCls,
  btnGhost,
  btnPrimary,
  cardCls,
  inputCls,
  textareaCls,
  textareaTallCls,
  labelCls,
  scoreTextCls,
  textErr,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import type { Application } from "@/lib/applications-types";
import { useResumeOptions } from "@/hooks/use-resume-options";
import { useResumeVersionSelection } from "@/hooks/use-resume-version-selection";
import { ResumeVersionSelect } from "@/components/resume/resume-version-select";
import { ResumeVersionBadge } from "@/components/resume/resume-version-badge";
import { RichText } from "@/components/resume/rich-text";
import { RichTextEditor } from "@/components/resume/rich-text-editor";
import { splitRichTextToLines, stripRichText } from "@/lib/rich-text";
import { LoadingOverlay } from "@/components/common/loading-overlay";

function valueText(value: string | string[] | null): string {
  return Array.isArray(value) ? value.join("\n") : value ?? "（目标不存在）";
}

function parseValueLines(value: string | string[] | null): string[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value;
  return splitRichTextToLines(value);
}

function DiagnosisValueDisplay({ value, emptyText }: { value: string | string[] | null; emptyText: string }) {
  if (value === null) {
    return <span>{emptyText}</span>;
  }
  const lines = parseValueLines(value);
  if (lines.length === 0 || (lines.length === 1 && !stripRichText(lines[0] ?? "").trim())) {
    return <span>{emptyText}</span>;
  }
  if (lines.length === 1) {
    return <RichText content={lines[0]} />;
  }
  return (
    <div className="space-y-1">
      {lines.map((item, idx) => (
        <div key={idx} className="flex items-start gap-1.5">
          <span className="text-primary font-bold select-none shrink-0">•</span>
          <span className="flex-1 min-w-0">
            <RichText content={item} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 「JD 诊断」对话框：粘贴 JD → AI 逐模块评分与差距说明 → 逐条改写建议以草稿呈现，
 * 用户确认后才写入简历（草稿确认制，写入走详情页自动保存链路）。
 */
export function DiagnoseDialog({
  resumeId,
  modules,
  onApply,
  triggerClassName,
}: {
  resumeId: string;
  modules: ModuleData[];
  onApply: (moduleKey: string, itemId: string, field: DiagnosisField, value: string | string[]) => boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [jd, setJd] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobId, setJobId] = useState("");
  const [preparation, setPreparation] = useState<{ id: number; jobId: string; resumeVersionId: number } | null>(null);
  const [data, setData] = useState<DiagnosisHistoryResponse | null>(null);
  const [editing, setEditing] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string | string[]>>({});
  const [preparationError, setPreparationError] = useState("");
  const record = data?.current ?? null;
  const report = editing ? null : record?.report ?? null;
  const history = data?.history ?? [];
  const jobs = [...new Set(history.map((entry) => entry.job_id))].map((id) => history.find((entry) => entry.job_id === id)!);
  const dialogRef = useModalFocus(open, () => { if (!busy) setOpen(false); }, "textarea");
  const { resumes, resumesError } = useResumeOptions(open);
  const selectedResume = resumes?.find((resume) => resume.id === Number(resumeId));
  const boundPreparation = preparation?.jobId === jobId ? preparation : null;
  const { resumeVersionId, setResumeVersionId } = useResumeVersionSelection(selectedResume,
    boundPreparation?.resumeVersionId ?? record?.resume_version_id);
  const canDiagnose = Boolean(resumeVersionId && jd.trim() && !preparationError);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get("diagnosisId");
    const applicationId = Number(query.get("applicationId"));
    if (!id || !/^\d+$/.test(id)) return;
    const controller = new AbortController();
    const applicationRequest = Number.isSafeInteger(applicationId) && applicationId > 0
      ? jsonFetch<Application>(`/api/applications/${applicationId}`, { signal: controller.signal }) : Promise.resolve(null);
    Promise.all([jsonFetch<DiagnosisHistoryResponse>(`/api/resumes/${resumeId}/diagnose?diagnosis_id=${id}`, { signal: controller.signal }), applicationRequest])
      .then(([result, application]) => {
        if (controller.signal.aborted) return;
        if (application && (application.resume_id !== Number(resumeId) || !application.resume_version_id)) {
          throw new Error("投递关联简历已变化或尚未选择发布版本，请返回投递准备页确认");
        }
        setData(result); setJd(result.current?.jd ?? ""); setJobTitle(result.current?.job_title ?? "");
        setJobId(result.current?.job_id ?? ""); setEditing(!result.current?.report); setOpen(true);
        if (application && result.current) {
          setPreparation({ id: application.id, jobId: result.current.job_id, resumeVersionId: application.resume_version_id! });
          setJd(application.jd);
        }
        setPreparationError("");
      }).catch((reason) => { if (!controller.signal.aborted) { setPreparationError(errorMessage(reason)); setOpen(true); } });
    return () => controller.abort();
  }, [resumeId]);

  function showResult(result: DiagnosisHistoryResponse) {
    setData(result);
    setJd(result.current?.jd ?? "");
    setJobTitle(result.current?.job_title ?? "");
    setJobId(result.current?.job_id ?? "");
    setEditing(!result.current?.report);
    setDrafts({});
    if (result.current && !result.current.report) setError("此历史报告已损坏，请重新诊断；历史记录仍保留");
  }

  async function loadHistory(query = "") {
    setBusy(true);
    setError("");
    try {
      showResult(await jsonFetch<DiagnosisHistoryResponse>(`/api/resumes/${resumeId}/diagnose${query}`));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function openDialog() {
    setOpen(true);
    await loadHistory();
  }

  function newJob() {
    setJobId("");
    setJobTitle("");
    setJd("");
    setEditing(true);
    setDrafts({});
    setError("");
    setData((previous) => previous ? { ...previous, current: null, previous: null } : null);
  }

  async function ensureSaved() {
    const queue = getResumeSaveQueue(resumeId);
    await queue.flush();
    if (queue.needsUnloadWarning) throw new Error("简历草稿尚未保存成功，请先解决保存问题再采纳建议");
  }

  async function runDiagnose() {
    if (busy || !canDiagnose) return;
    setBusy(true);
    setError("");
    try {
      const result = await jsonFetch<DiagnosisHistoryResponse>(`/api/resumes/${resumeId}/diagnose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jd, resume_version_id: resumeVersionId, job_title: jobTitle, ...(jobId ? { job_id: jobId } : { new_job: true }), ...(boundPreparation ? { application_id: boundPreparation.id } : {}) }),
      });
      showResult(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function draftOf(key: string, s: DiagnosisSuggestion, saved?: string | string[]): string {
    if (saved !== undefined) return valueText(saved);
    const draft = drafts[key];
    if (typeof draft === "string") return draft;
    if (Array.isArray(draft)) return draft.join("\n");
    return valueText(s.draft);
  }

  function draftLinesOf(key: string, s: DiagnosisSuggestion): string[] {
    const draft = drafts[key];
    if (Array.isArray(draft)) return draft.length > 0 ? draft : [""];
    if (typeof draft === "string") {
      const parsed = splitRichTextToLines(draft);
      return parsed.length > 0 ? parsed : [""];
    }
    const fallback = Array.isArray(s.draft) ? s.draft : splitRichTextToLines(s.draft);
    return fallback.length > 0 ? fallback : [""];
  }

  function updateDescLine(key: string, s: DiagnosisSuggestion, index: number, val: string) {
    const lines = [...draftLinesOf(key, s)];
    lines[index] = val;
    setDrafts((prev) => ({ ...prev, [key]: lines }));
  }

  function addDescLine(key: string, s: DiagnosisSuggestion) {
    const lines = [...draftLinesOf(key, s), ""];
    setDrafts((prev) => ({ ...prev, [key]: lines }));
  }

  function removeDescLine(key: string, s: DiagnosisSuggestion, index: number) {
    const lines = draftLinesOf(key, s);
    if (lines.length <= 1) {
      setDrafts((prev) => ({ ...prev, [key]: [""] }));
      return;
    }
    const next = lines.filter((_, i) => i !== index);
    setDrafts((prev) => ({ ...prev, [key]: next }));
  }

  function moveDescLine(key: string, s: DiagnosisSuggestion, index: number, delta: -1 | 1) {
    const lines = [...draftLinesOf(key, s)];
    const target = index + delta;
    if (target < 0 || target >= lines.length) return;
    const [moved] = lines.splice(index, 1);
    if (moved === undefined) return;
    lines.splice(target, 0, moved);
    setDrafts((prev) => ({ ...prev, [key]: lines }));
  }

  async function apply(moduleKey: string, index: number, key: string, s: DiagnosisSuggestion) {
    if (busy || !record) return;
    let value: string | string[];
    if (s.field === "items") {
      const text = draftOf(key, s);
      value = text.split("\n").map((t) => t.trim()).filter(Boolean);
    } else if (s.field === "description") {
      const lines = draftLinesOf(key, s).map((t) => t.trim()).filter(Boolean);
      value = lines.join("\n");
    } else {
      const text = draftOf(key, s);
      value = text.trim();
    }
    const isEmpty =
      typeof value === "string" ? !stripRichText(value).trim() : value.length === 0;
    if (isEmpty) {
      await alertDialog({ title: "无法采纳", message: "草稿内容为空。" });
      return;
    }
    setBusy(true);
    setError("");
    try {
      await ensureSaved();
      const original = diagnosisValue(record.resume_snapshot.modules, moduleKey, s);
      const current = diagnosisValue(modules, moduleKey, s);
      if (current === null) throw new Error("目标模块或条目已被删除，无法写入");
      if (JSON.stringify(original) !== JSON.stringify(current) &&
          !await confirmDialog({ title: "确认替换当前内容", message: "当前内容与诊断时不同，采纳会整段替换当前内容。请确认已查看内容变化。", confirmText: "确认采纳" })) return;
      if (!onApply(moduleKey, s.itemId, s.field, value)) throw new Error("目标模块或条目已被删除或移动，无法写入");
      await ensureSaved();
      setData(await jsonFetch<DiagnosisHistoryResponse>(`/api/resumes/${resumeId}/diagnose`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diagnosis_id: record.id, module_key: moduleKey, suggestion_index: index, value }),
      }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className={
          triggerClassName ??
          "rounded-full border border-line px-3 py-1 text-xs font-medium text-muted transition-colors hover:bg-surface hover:text-ink cursor-pointer"
        }
        onClick={openDialog}
      >
        <span className="flex items-center gap-1">
          <svg className="h-3.5 w-3.5 text-primary" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
              clipRule="evenodd"
            />
          </svg>
          <span>JD 诊断</span>
        </span>
      </button>
    );
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="对 JD 体检诊断简历"
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-[2px]"
      onClick={() => { if (!busy) setOpen(false); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="dialog-in relative flex flex-col max-h-[90dvh] w-full max-w-3xl overflow-hidden rounded-2xl border border-line bg-card shadow-card-float outline-none"
      >
        <LoadingOverlay
          show={busy}
          message="AI 简历诊断中…"
          description="正在结合目标岗位 JD 逐模块评分、比对差距并构思改写建议，请稍候…"
        />

        {/* 固定顶栏 */}
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5 sm:px-6">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-base sm:text-lg font-bold text-ink tracking-tight">
              {report ? "JD 诊断报告" : "诊断已发布的简历版本"}
            </h2>
            {report && record && (
              <span className="hidden sm:inline-block text-xs text-faint">
                诊断时间：{new Date(record.created_at).toLocaleString()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {report && (
              <button
                className={`${btnGhost} text-xs px-2.5 py-1 min-h-[32px]`}
                onClick={() => {
                  setEditing(true);
                  setDrafts({});
                }}
                disabled={busy}
              >
                修改岗位 JD
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink"
              aria-label="关闭"
              disabled={busy}
            >
              ×
            </button>
          </div>
        </div>

        {/* 滚动正文 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-6 space-y-4">
          {history.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="min-w-0"><span className={labelCls}>岗位</span><select className={`${inputCls} mt-1 w-full`} value={jobId} disabled={busy} onChange={(event) => { if (event.target.value) void loadHistory(`?job_id=${encodeURIComponent(event.target.value)}`); else newJob(); }}><option value="">新岗位</option>{jobs.map((job) => <option key={job.job_id} value={job.job_id}>{job.job_title}</option>)}</select></label>
              <label className="min-w-0"><span className={labelCls}>诊断历史</span><select className={`${inputCls} mt-1 w-full`} value={editing ? "" : record?.id ?? ""} disabled={busy || !jobId} onChange={(event) => void loadHistory(`?diagnosis_id=${event.target.value}`)}><option value="" disabled>选择历史版本</option>{history.filter((entry) => entry.job_id === jobId).map((entry) => <option key={entry.id} value={entry.id}>#{entry.id} · {new Date(entry.created_at).toLocaleString()} · {entry.match ?? "未评分"} 分</option>)}</select></label>
            </div>
          )}
          {busy && <p role="status" className="text-sm text-muted">正在处理，请稍候…</p>}
          {error && <p role="alert" className={`text-sm ${textErr}`}>{error}</p>}
          {(resumesError || preparationError) && <p role="alert" className={`text-sm ${textErr}`}>{resumesError || preparationError}</p>}
          {resumes === null && <p role="status" className="text-sm text-muted">正在读取已发布版本…</p>}
          <ResumeVersionSelect resume={selectedResume} value={resumeVersionId} onChange={setResumeVersionId} disabled={busy || Boolean(boundPreparation)} />
          {boundPreparation && <p className="text-xs text-muted">已固定本次投递的简历版本与 JD；调整关联资料请返回投递准备页。</p>}
          {report && record && <ResumeVersionBadge resume_version_id={record.resume_version_id} resume_version={selectedResume?.versions.find((version) => version.id === record.resume_version_id)?.version} resume_version_name={selectedResume?.versions.find((version) => version.id === record.resume_version_id)?.name} />}
          {report ? (
            <>
              {record && <div className="text-sm text-muted"><p>{record.job_title} · #{record.id}</p><p className="mt-1">本次建议已采纳 {record.adoptions.length} / {report.modules.reduce((sum, module) => sum + module.suggestions.length, 0)} 条</p><details className="mt-2"><summary className="cursor-pointer">查看本次岗位 JD</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs">{record.jd}</pre></details><details className="mt-2"><summary className="cursor-pointer">查看诊断时的简历快照</summary><pre role="region" aria-label="诊断时简历快照" className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-3 font-sans text-xs leading-relaxed">{resumeToMarkdown(record.resume_snapshot.title, record.resume_snapshot.modules)}</pre></details></div>}
              <div className="rounded-xl border border-primary/25 bg-primary-soft/40 p-4 sm:p-5">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-base font-semibold">总体评价</h3>
                  <div className="text-right">
                    <p className="text-xs text-faint">岗位匹配度</p>
                    <p
                      className={`font-mono text-3xl sm:text-4xl font-semibold tabular-nums leading-none ${scoreTextCls(report.match)}`}
                    >
                      {report.match}
                    </p>
                  </div>
                </div>
                {report.summary && (
                  <RichText as="p" className="mt-3 text-sm leading-relaxed text-muted" content={report.summary} />
                )}
              </div>

              {record && <DiagnosisChanges current={record} previous={data?.previous ?? null} modules={modules} />}

              <div className="space-y-3">
                {report.modules.map((md) => (
                  <div key={md.moduleKey} className={`${cardCls} p-4`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-sm font-semibold">{md.label}</span>
                      {DIMENSIONS.map((d) => (
                        <span key={d.key} className={`${badgeCls} tabular-nums`} title={d.hint}>
                          {d.label}
                          <span className={`font-mono font-medium ${scoreTextCls(md.scores[d.key])}`}>
                            {md.scores[d.key]}
                          </span>
                        </span>
                      ))}
                    </div>
                    {md.gaps && (
                      <RichText as="p" className="mt-2 text-sm leading-relaxed text-muted" content={md.gaps} />
                    )}
                    {md.suggestions.map((s, i) => {
                      const key = `${md.moduleKey}|${s.itemId}|${s.field}|${i}`;
                      const adoption = record?.adoptions.find((entry) => entry.moduleKey === md.moduleKey && entry.suggestionIndex === i);
                      const done = Boolean(adoption);
                      const current = diagnosisValue(modules, md.moduleKey, s);
                      const original = record ? diagnosisValue(record.resume_snapshot.modules, md.moduleKey, s) : null;
                      return (
                        <div key={key} className="mt-3 rounded-lg border border-line bg-bg p-3">
                          {s.reason && (
                            <p className="text-xs leading-relaxed text-muted">建议：<RichText content={s.reason} /></p>
                          )}
                          <p className="mt-2 text-xs font-medium text-muted">诊断时原文</p>
                          <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface/60 px-3 py-2 text-xs leading-relaxed text-muted">
                            <DiagnosisValueDisplay value={original} emptyText="（当时内容为空）" />
                          </div>
                          {JSON.stringify(original) !== JSON.stringify(current) && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-xs text-accent">查看当前内容（诊断后有变化）</summary>
                              <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface/60 px-3 py-2 text-xs leading-relaxed text-muted">
                                <DiagnosisValueDisplay value={current} emptyText="（当前内容为空）" />
                              </div>
                            </details>
                          )}
                          <div className="mt-2 block">
                            <span className={labelCls}>
                              {done
                                ? "改写草稿（已采纳，显示当时写入内容）"
                                : s.field === "description"
                                  ? "改写草稿（可分行编辑，支持富文本排版，采纳后整段替换原文）"
                                  : `改写草稿（可编辑${s.field === "items" ? "，每行一项技能" : "，支持富文本排版"}，采纳后整段替换${s.field === "items" ? "全部技能" : "原文"}）`}
                            </span>
                            {done ? (
                              <div className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-surface/60 px-3 py-2 text-xs leading-relaxed text-muted">
                                <DiagnosisValueDisplay value={adoption?.value ?? s.draft} emptyText="（采纳内容为空）" />
                              </div>
                            ) : s.field === "description" ? (
                              <div className="mt-1 space-y-2">
                                {draftLinesOf(key, s).map((desc, descIndex, arr) => (
                                  <div
                                    key={descIndex}
                                    className="flex items-start gap-2 rounded-lg border border-line bg-surface/40 p-2 shadow-2xs transition-all hover:border-line-strong"
                                  >
                                    <div className="flex flex-col items-center gap-0.5 pt-1 shrink-0">
                                      <span className="font-mono text-xs font-bold text-primary select-none">
                                        •
                                      </span>
                                    </div>

                                    <div className="flex flex-col gap-1 shrink-0 pt-0.5">
                                      <button
                                        type="button"
                                        title="上移此行"
                                        aria-label={`上移第 ${descIndex + 1} 行`}
                                        disabled={busy || descIndex === 0}
                                        onClick={() => moveDescLine(key, s, descIndex, -1)}
                                        className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30 cursor-pointer"
                                      >
                                        ↑
                                      </button>
                                      <button
                                        type="button"
                                        title="下移此行"
                                        aria-label={`下移第 ${descIndex + 1} 行`}
                                        disabled={busy || descIndex === arr.length - 1}
                                        onClick={() => moveDescLine(key, s, descIndex, 1)}
                                        className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30 cursor-pointer"
                                      >
                                        ↓
                                      </button>
                                    </div>

                                    <div className="flex-1 min-w-0">
                                      <RichTextEditor
                                        value={desc}
                                        onChange={(val) => updateDescLine(key, s, descIndex, val)}
                                        placeholder="描述此项经历的具体内容，支持加粗与颜色…"
                                        minHeightClass="min-h-[56px]"
                                        ariaLabel={arr.length === 1 ? "改写草稿" : `改写草稿第 ${descIndex + 1} 行`}
                                      />
                                    </div>

                                    <button
                                      type="button"
                                      onClick={() => removeDescLine(key, s, descIndex)}
                                      title="删除该行"
                                      aria-label={`删除第 ${descIndex + 1} 行`}
                                      disabled={busy}
                                      className="text-xs text-muted hover:text-danger p-1 rounded transition-colors shrink-0 mt-0.5 cursor-pointer"
                                    >
                                      ×
                                    </button>
                                  </div>
                                ))}

                                <div className="flex items-center justify-between pt-1">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => addDescLine(key, s)}
                                    className="text-xs font-medium text-primary hover:underline cursor-pointer"
                                  >
                                    + 添加一行描述
                                  </button>
                                </div>
                              </div>
                            ) : s.field === "items" ? (
                              <textarea
                                className={`${textareaCls} mt-1`}
                                value={draftOf(key, s)}
                                disabled={busy}
                                aria-label="改写草稿"
                                onChange={(e) =>
                                  setDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                              />
                            ) : (
                              <div className="mt-1">
                                <RichTextEditor
                                  value={draftOf(key, s)}
                                  onChange={(val) =>
                                    setDrafts((prev) => ({ ...prev, [key]: val }))
                                  }
                                  placeholder="可编辑改写草稿，支持加粗与颜色…"
                                  minHeightClass="min-h-[72px]"
                                  ariaLabel="改写草稿"
                                />
                              </div>
                            )}
                          </div>
                          <div className="mt-2 flex justify-end">
                            {done ? (
                              <span className="text-xs font-medium text-primary">已采纳写入 · {current === null ? "目标已删除" : JSON.stringify(current) === JSON.stringify(adoption?.value) ? "当前保留" : "后续已修改"} · {new Date(adoption!.applied_at).toLocaleString()}</span>
                            ) : (
                              <button
                                className={btnPrimary}
                                disabled={busy}
                                onClick={() => void apply(md.moduleKey, i, key, s)}
                              >
                                采纳写入
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">
                AI 将根据所选发布版本逐模块评分、指出与岗位的差距，并给出改写建议。草稿修改需先发布才能参与诊断；建议经你确认后写入当前草稿。
              </p>
              <label className="block"><span className={labelCls}>岗位名称（可选，便于区分公司和岗位）</span><input className={`${inputCls} mt-1 w-full`} maxLength={100} value={jobTitle} disabled={busy} placeholder="例如：某公司 · 前端工程师" onChange={(event) => setJobTitle(event.target.value)} /></label>
              <label className="block">
                <span className={labelCls}>岗位要求（JD）</span>
                <textarea
                  className={`${textareaTallCls} mt-1`}
                  placeholder="粘贴目标岗位的 JD 全文…"
                  value={jd}
                  disabled={busy}
                  readOnly={Boolean(boundPreparation)}
                  onChange={(e) => setJd(e.target.value)}
                />
              </label>
            </>
          )}
        </div>

        {/* 固定底栏 */}
        <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-5 py-3 sm:px-6 bg-card">
          {report && <><button className={btnGhost} onClick={newJob} disabled={busy}>诊断新岗位</button><button className={btnPrimary} onClick={() => void runDiagnose()} disabled={busy || !canDiagnose}>按所选发布版本再次诊断</button></>}
          {report === null && (
            <button className={btnPrimary} onClick={() => void runDiagnose()} disabled={busy || !canDiagnose}>
              {busy ? "处理中…" : "开始诊断"}
            </button>
          )}
          <button className={report ? btnPrimary : btnGhost} onClick={() => setOpen(false)} disabled={busy}>
            {report ? "完成并关闭" : "取消"}
          </button>
        </div>
      </div>
    </div>, document.body
  );
}
