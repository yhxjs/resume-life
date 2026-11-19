import type { ResumeVersionBinding } from "@/components/resume/resume-version-badge";

type HistoryIdentity = ResumeVersionBinding & { jd: string; resume_title: string; created_at: string };

/** 删除确认保留完整来源，不使用卡片截断后的 JD。 */
export function interviewDeletionTitle(item: HistoryIdentity): string {
  const version = item.resume_version_id === null ? "旧记录未绑定发布版"
    : `v${item.resume_version} · ${item.resume_version_name}（发布版 #${item.resume_version_id}）`;
  return `参考简历：${item.resume_title || "未命名"}；${version}；JD：${item.jd || "未提供"}；创建时间：${item.created_at || "未记录时间"}`;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const textFields = (value: Record<string, unknown>, fields: string[]) => fields.every(key => typeof value[key] === "string");

function validIdentity(value: Record<string, unknown>, id: number) {
  return positiveId(value.id) && value.id === id && positiveId(value.resume_id) && positiveId(value.rounds) &&
    textFields(value, ["jd", "resume_title", "created_at", "finished_at"]) && typeof value.status === "string" && ["ongoing", "finished"].includes(value.status) &&
    (value.resume_version_id === null ? value.resume_version === null && value.resume_version_name === null
      : positiveId(value.resume_version_id) && positiveId(value.resume_version) && typeof value.resume_version_name === "string");
}

/** 只读核对实体和历史正文；不按新生成上限裁剪旧题目，也不因损坏报告被标记 null 而拒绝核对。 */
export function validateExistingInterview(value: unknown, id: number): void {
  if (record(value) && validIdentity(value, id) && value.series_id === null && value.round_no === 0 && typeof value.style === "string" &&
    Array.isArray(value.turns) && value.turns.every(turn => record(turn) && positiveId(turn.id) && nonnegative(turn.idx) &&
      textFields(turn, ["question", "answer", "comment", "reference", "answered_at", "kind"]))) return;
  throw new Error("读取响应不完整或面试记录不符");
}

export function validateExistingInterviewSeries(value: unknown, id: number): void {
  if (record(value) && validIdentity(value, id) && value.rounds_total === 3 && Array.isArray(value.entries) &&
    value.entries.every(entry => record(entry) && positiveId(entry.interview_id) && positiveId(entry.round_no) && entry.round_no <= 3 &&
      positiveId(entry.rounds) && nonnegative(entry.answered) && typeof entry.style === "string" && typeof entry.status === "string" && ["ongoing", "finished"].includes(entry.status))) return;
  throw new Error("读取响应不完整或进阶面试记录不符");
}
