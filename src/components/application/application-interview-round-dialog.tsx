"use client";

import { useId, useState } from "react";
import { Modal } from "@/components/common/modal";
import {
  ROUND_STATUS_CONFIG,
  type Application,
  type ApplicationInterview,
  type InterviewRoundStatus,
} from "@/lib/applications-types";
import { jsonFetch } from "@/lib/fetcher";
import { fromLocalDateTime, toLocalDateTime } from "@/lib/application-datetime";
import { errorMessage } from "@/lib/error-message";
import { btnGhost, btnPrimary, inputCls, labelCls, textareaShortCls } from "@/lib/ui";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { DateTimePicker } from "@/components/common/date-time-picker";

interface ApplicationInterviewRoundDialogProps {
  application: Application;
  initialInterview?: ApplicationInterview | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const PRESET_ROUNDS = ["一面", "二面", "三面", "总监面", "HR面", "技术加试"];
const PRESET_LOCATIONS = ["腾讯会议", "飞书会议", "钉钉会议", "Zoom", "电话面试", "公司现场"];
const REMINDER_OPTIONS = [
  { value: 0, label: "不提醒" },
  { value: 15, label: "提前 15 分钟 (推荐)" },
  { value: 30, label: "提前 30 分钟" },
  { value: 60, label: "提前 1 小时" },
  { value: 120, label: "提前 2 小时" },
  { value: 1440, label: "提前 1 天" },
];

export function ApplicationInterviewRoundDialog({
  application: app,
  initialInterview,
  open,
  onClose,
  onSuccess,
}: ApplicationInterviewRoundDialogProps) {
  const isEdit = Boolean(initialInterview);
  const timeLabelId = useId();
  const [roundName, setRoundName] = useState(initialInterview?.round_name ?? "一面");
  const [status, setStatus] = useState<InterviewRoundStatus>(
    initialInterview?.status ?? "scheduled"
  );
  const [interviewTime, setInterviewTime] = useState(
    toLocalDateTime(initialInterview?.interview_time ?? "")
  );
  const [interviewer, setInterviewer] = useState(initialInterview?.interviewer ?? "");
  const [location, setLocation] = useState(initialInterview?.location ?? "");
  const [meetingUrl, setMeetingUrl] = useState(initialInterview?.meeting_url ?? "");
  const [reminderMinutes, setReminderMinutes] = useState<number>(
    initialInterview?.reminder_minutes ?? 15
  );
  const [notes, setNotes] = useState(initialInterview?.notes ?? "");
  const [advanceStage, setAdvanceStage] = useState(
    app.stage === "interested" || app.stage === "applied" || app.stage === "interviewing"
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function handleMeetingUrlBlur() {
    const trimmed = meetingUrl.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed)) {
      setMeetingUrl(`https://${trimmed}`);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!roundName.trim()) {
      setError("面试轮次名称不能为空");
      return;
    }

    setSaving(true);
    setError("");

    try {
      const payload = {
        round_name: roundName.trim(),
        status,
        interview_time: fromLocalDateTime(interviewTime, initialInterview?.interview_time),
        interviewer: interviewer.trim(),
        location: location.trim(),
        meeting_url: meetingUrl.trim(),
        reminder_minutes: reminderMinutes,
        notes: notes.trim(),
        advance_stage: !isEdit && advanceStage,
      };

      if (isEdit && initialInterview) {
        await jsonFetch(
          `/api/applications/${app.id}/interviews/${initialInterview.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }
        );
      } else {
        await jsonFetch(`/api/applications/${app.id}/interviews`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      onSuccess();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!initialInterview) return;
    const ok = await confirmDialog({
      title: "确认删除该轮面试？",
      message: `确定要删除【${initialInterview.round_name}】的记录吗？此操作不可恢复。`,
      confirmText: "确认删除",
      danger: true,
    });
    if (!ok) return;

    setSaving(true);
    try {
      await jsonFetch(
        `/api/applications/${app.id}/interviews/${initialInterview.id}`,
        {
          method: "DELETE",
        }
      );
      onSuccess();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${isEdit ? "编辑面试轮次" : "登记新面试轮次"} · ${app.company}`}
      loading={saving}
      loadingText={isEdit ? "正在保存面试轮次…" : "正在登记新面试轮次…"}
      loadingDescription="正在更新投递进度与面试日程，请稍候…"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 头部标题与投递信息 */}
        <div className="flex items-center justify-between border-b border-line pb-3">
          <div>
            <h3 className="font-serif text-base font-bold text-ink">
              {isEdit ? "编辑面试轮次" : "登记新面试轮次"}
            </h3>
            <p className="text-xs text-muted mt-0.5">
              {app.company} · {app.role}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭弹窗"
            className="text-muted hover:text-ink p-1"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger-wash p-2.5 text-xs text-danger">
            {error}
          </div>
        )}

        {/* 轮次名称与快捷选择 */}
        <div>
          <label className={labelCls}>
            轮次名称 <span className="text-danger">*</span>
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {PRESET_ROUNDS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setRoundName(name)}
                className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                  roundName === name
                    ? "border-primary bg-primary text-on-primary font-bold shadow-xs"
                    : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={roundName}
            onChange={(e) => setRoundName(e.target.value)}
            placeholder="自定义轮次名称，如：技术一面、HR面、现场终面..."
            className={inputCls}
            required
          />
        </div>

        {/* 轮次状态与面试时间 */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>轮次状态</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as InterviewRoundStatus)}
              className={inputCls}
            >
              {(Object.keys(ROUND_STATUS_CONFIG) as InterviewRoundStatus[]).map((st) => (
                <option key={st} value={st}>
                  {ROUND_STATUS_CONFIG[st].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span id={timeLabelId} className={labelCls}>面试时间</span>
            <DateTimePicker
              ariaLabelledBy={timeLabelId}
              value={interviewTime}
              onChange={setInterviewTime}
              placeholder="选择面试时间..."
            />
          </div>
        </div>

        {/* 提醒时间设置 */}
        <div>
          <label className={labelCls}>
            <span>面试前提醒闹钟</span>
            <span className="ml-1 text-[11px] font-normal text-muted">（导出日历将包含 VALARM 提醒，应用内将高亮倒计时）</span>
          </label>
          <select
            value={reminderMinutes}
            onChange={(e) => setReminderMinutes(Number(e.target.value))}
            className={inputCls}
          >
            {REMINDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* 会议地点 / 平台与快捷预设 */}
        <div>
          <label className={labelCls}>面试地点 / 平台</label>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {PRESET_LOCATIONS.map((loc) => (
              <button
                key={loc}
                type="button"
                onClick={() => setLocation(loc)}
                className={`rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ${
                  location === loc
                    ? "border-primary bg-primary-soft text-primary font-bold shadow-xs"
                    : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {loc}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="如：腾讯会议、飞书会议、公司现场望京A座502..."
            className={inputCls}
          />
        </div>

        {/* 会议直达链接 */}
        <div>
          <label className={labelCls}>
            <span>线上会议链接 (URL)</span>
            <span className="ml-1 text-[11px] font-normal text-muted">（日历卡片可一键直达或复制）</span>
          </label>
          <input
            type="url"
            value={meetingUrl}
            onChange={(e) => setMeetingUrl(e.target.value)}
            onBlur={handleMeetingUrlBlur}
            placeholder="如：https://meeting.tencent.com/dm/... 或 voovmeeting.com"
            className={inputCls}
          />
        </div>

        {/* 面试官姓名 */}
        <div>
          <label className={labelCls}>面试官</label>
          <input
            type="text"
            value={interviewer}
            onChange={(e) => setInterviewer(e.target.value)}
            placeholder="如：业务主管王老师、HR李老师"
            className={inputCls}
          />
        </div>

        {/* 面试手记 / 问到的要点 */}
        <div>
          <label className={labelCls}>轮次备忘 / 面试要点手记</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="可记录面试官重点关心的项目、遇到的难点提问、待补充资料等..."
            className={textareaShortCls}
          />
        </div>

        {/* 自动推进看板阶段勾选 */}
        {!isEdit && app.stage !== "interview" && (
          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer hover:text-ink select-none pt-1">
            <input
              type="checkbox"
              checked={advanceStage}
              onChange={(e) => setAdvanceStage(e.target.checked)}
              className="rounded border-line text-primary focus:ring-primary"
            />
            <span>同时将投递卡片流转到「面试中」阶段</span>
          </label>
        )}

        {/* 底部按钮栏 */}
        <div className="flex items-center justify-between border-t border-line pt-3">
          <div>
            {isEdit && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="text-xs text-danger hover:underline"
              >
                删除本轮面试
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className={btnGhost}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className={btnPrimary}
            >
              {saving ? "保存中..." : isEdit ? "更新轮次" : "确认添加"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
