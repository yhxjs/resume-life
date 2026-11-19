import type { Application, CreateApplicationInput } from "@/lib/applications-types";
import { validateExistingApplication } from "@/lib/application-deletion";

/** 写入回复或显式核对须属于目标投递，并完整保留本次提交的可编辑字段。 */
export function readSavedApplication(value: unknown, expectedId: number | null, input: CreateApplicationInput): Application {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("投递保存响应不完整");
  const saved = value as Application;
  validateExistingApplication(saved, expectedId ?? saved.id);
  const fields = ["company", "role", "salary_range", "stage", "batch_name", "jd", "notes", "next_interview_at", "terminal_stage", "terminal_reason"] as const;
  if (fields.some(key => input[key] !== undefined && saved[key] !== input[key])
    || (["resume_id", "resume_version_id", "interview_id", "interview_series_id"] as const).some(key => input[key] !== undefined && (saved[key] ?? null) !== input[key])) {
    throw new Error("服务端当前投递与本次提交不一致");
  }
  const hiring = input.stage === "rejected" ? input.terminal_stage : input.hiring_stage;
  const flow = input.stage === "rejected" ? "terminated" : input.stage === "offer" ? "passed" : "active";
  if ((hiring !== undefined && saved.hiring_stage !== hiring) || saved.flow_status !== flow) throw new Error("服务端投递流程与本次提交不一致");
  return saved;
}
