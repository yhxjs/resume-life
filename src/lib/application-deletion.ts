import { APPLICATION_FLOW_STATUSES, APPLICATION_TERMINAL_STAGES, ROUND_STATUS_CONFIG, STAGE_CONFIG, type Application } from "@/lib/applications-types";
import { readPreparationTask } from "@/lib/application-preparation-response";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableId = (value: unknown) => value === null || id(value);
const stage = (value: unknown) => typeof value === "string" && Object.hasOwn(STAGE_CONFIG, value);
const hiringStage = (value: unknown) => value === null || (typeof value === "string" && APPLICATION_TERMINAL_STAGES.some(item => item === value));
function fail(): never { throw new Error("投递核对响应不完整或记录不符"); }

/** 只有同一投递的完整详情才可证明删除后仍存在，不接受串 ID 或残缺成功回复。 */
export function validateExistingApplication(value: unknown, applicationId: number): void {
  if (!object(value) || value.id !== applicationId || !id(value.id) || !stage(value.stage)
    || !APPLICATION_FLOW_STATUSES.some(item => item === value.flow_status)
    || ["company", "role", "salary_range", "jd", "notes", "next_interview_at", "created_at", "updated_at", "batch_name", "stage_changed_at", "terminal_reason", "terminal_at"].some(key => typeof value[key] !== "string")
    || !hiringStage(value.hiring_stage) || !hiringStage(value.terminal_stage)
    || ![value.resume_id, value.interview_id, value.interview_series_id].every(nullableId)
    || (value.resume_version_id != null && !id(value.resume_version_id))
    || !Array.isArray(value.interviews) || !Array.isArray(value.stage_history) || !Array.isArray(value.preparation_tasks)) fail();
  const ids = new Set<number>();
  for (const row of value.interviews) {
    if (!object(row) || !id(row.id) || ids.has(row.id) || row.application_id !== applicationId
      || typeof row.status !== "string" || !Object.hasOwn(ROUND_STATUS_CONFIG, row.status)
      || ["round_name", "interview_time", "interviewer", "notes", "created_at", "updated_at"].some(key => typeof row[key] !== "string")) fail();
    ids.add(row.id);
  }
  ids.clear();
  for (const row of value.stage_history) {
    if (!object(row) || !id(row.id) || ids.has(row.id) || row.application_id !== applicationId
      || !(row.from_stage === null || stage(row.from_stage)) || !stage(row.to_stage)
      || ![row.from_hiring_stage, row.to_hiring_stage, row.terminal_stage].every(hiringStage)
      || typeof row.changed_at !== "string" || typeof row.reason !== "string") fail();
    ids.add(row.id);
  }
  ids.clear();
  for (const row of value.preparation_tasks) {
    const task = readPreparationTask(row); if (ids.has(task.id)) fail(); ids.add(task.id);
  }
}

export function applicationDeletionTitle(app: Application): string {
  return `${app.company} · ${app.role}\n阶段：${STAGE_CONFIG[app.stage].label}\n批次：${app.batch_name || "未分批"}\n创建：${app.created_at || "历史时间未知"}\n更新：${app.updated_at || "历史时间未知"}`;
}
