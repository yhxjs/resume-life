import { ApplicationInputError, createApplication, createApplicationInterview, getApplicationById, updateApplication } from "@/lib/applications";
import type { ApplicationStage, ApplicationTerminalStage, CreateApplicationInput, CreateApplicationInterviewInput } from "@/lib/applications-types";
import { getDb, inTransaction } from "@/lib/db";
import { completePreparationStep, getPreparationPlan } from "@/lib/preparation-plan";
import { createPreparationTask, normalizePreparationDueTime, PreparationInputError } from "@/lib/application-preparation";
import type { PlanStepKey } from "@/lib/preparation-plan-types";
import { mcpRevision } from "@/lib/mcp-revision";
import { McpOperationError } from "./mcp-errors";
import { compactMcpApplication, compactMcpPreparationPlan } from "./mcp-read";
import { mcpCreateOnce } from "./mcp-state";

export function assertMcpApplicationRevision(id: number, revision: string) {
  const app = getApplicationById(id);
  if (!app) throw new McpOperationError("NOT_FOUND", "投递记录不存在");
  if (mcpRevision("application", app) !== revision) throw new McpOperationError("CONFLICT", "投递资料已更新，请重新读取后再提交");
  return app;
}

export function createMcpApplication(input: CreateApplicationInput & { idempotencyKey: string }) {
  const { idempotencyKey, ...fields } = input;
  return mcpCreateOnce("create_application", idempotencyKey, fields, () => createApplication(fields),
    id => Boolean(getDb().prepare("SELECT 1 FROM applications WHERE id = ?").get(id)));
}

export function createMcpPreparationTask(input: { applicationId: number; expectedRevision: string; idempotencyKey: string; title: string; dueTime?: string }) {
  const { idempotencyKey, ...fields } = input;
  return mcpCreateOnce("create_preparation_task", idempotencyKey, fields, () => {
    assertMcpApplicationRevision(input.applicationId, input.expectedRevision);
    return createPreparationTask(input.applicationId, input.title, input.dueTime);
  }, id => Boolean(getDb().prepare("SELECT 1 FROM application_preparation_tasks WHERE id = ? AND application_id = ?").get(id, input.applicationId)));
}

export function scheduleMcpInterview(input: CreateApplicationInterviewInput & { applicationId: number; expectedRevision: string; idempotencyKey: string }) {
  const { applicationId, expectedRevision, idempotencyKey, ...fields } = input;
  return mcpCreateOnce("schedule_application_interview", idempotencyKey, { applicationId, expectedRevision, ...fields }, () => {
    assertMcpApplicationRevision(applicationId, expectedRevision);
    const interview_time = normalizePreparationDueTime(fields.interview_time);
    if (!interview_time) throw new McpOperationError("INVALID_ARGUMENT", "安排面试需提供带时区的面试时间");
    return createApplicationInterview(applicationId, { ...fields, interview_time });
  }, id => Boolean(getDb().prepare("SELECT 1 FROM application_interviews WHERE id = ? AND application_id = ?").get(id, applicationId)));
}

export function updateMcpApplication(id: number, input: {
  expectedRevision: string;
  stage?: ApplicationStage;
  notes?: string;
  terminal_stage?: ApplicationTerminalStage;
  terminal_reason?: string;
}, returnDetails: boolean) {
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new ApplicationInputError("更新投递时必须提供读取到的 revision，避免覆盖较新的修改");
  }
  if (input.stage === undefined && input.notes === undefined && input.terminal_stage === undefined && input.terminal_reason === undefined) {
    throw new ApplicationInputError("请至少提供一个待更新字段");
  }
  return inTransaction(() => {
    const current = getApplicationById(id);
    if (!current) throw new McpOperationError("NOT_FOUND", "未找到对应投递记录");
    if (mcpRevision("application", current) !== input.expectedRevision) {
      throw new McpOperationError("CONFLICT", "投递记录已更新，请重新读取后再提交");
    }
    if ((input.terminal_stage !== undefined || input.terminal_reason !== undefined) && (input.stage ?? current.stage) !== "rejected") {
      throw new ApplicationInputError("仅终止投递时可设置终止阶段和原因");
    }
    const updated = updateApplication(id, {
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.terminal_stage !== undefined ? { terminal_stage: input.terminal_stage } : {}),
      ...(input.terminal_reason !== undefined ? { terminal_reason: input.terminal_reason } : {}),
    });
    return returnDetails ? compactMcpApplication(updated) : { id };
  });
}

export function setMcpPreparationStep(applicationId: number, input: {
  expectedRevision: string;
  contextKey: string;
  key: PlanStepKey;
  done: boolean;
}, returnDetails: boolean) {
  if (typeof input.contextKey !== "string" || !/^[a-f0-9]{64}$/.test(input.contextKey)) {
    throw new PreparationInputError("请提供读取准备计划时返回的 contextKey");
  }
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new PreparationInputError("请提供读取准备计划时返回的 revision");
  }
  return inTransaction(() => {
    const current = getPreparationPlan(applicationId);
    if (mcpRevision("preparation-plan", current) !== input.expectedRevision || current.contextKey !== input.contextKey) {
      throw new McpOperationError("CONFLICT", "准备计划已更新，请重新读取后再提交");
    }
    const updated = completePreparationStep(applicationId, input);
    return returnDetails ? compactMcpPreparationPlan(updated) : { applicationId, key: input.key, done: input.done };
  });
}

