import { ApplicationInputError, getApplicationById, updateApplication } from "@/lib/applications";
import type { ApplicationStage, ApplicationTerminalStage } from "@/lib/applications-types";
import { inTransaction } from "@/lib/db";
import { completePreparationStep, getPreparationPlan } from "@/lib/preparation-plan";
import { PreparationInputError } from "@/lib/application-preparation";
import type { PlanStepKey } from "@/lib/preparation-plan-types";
import { mcpRevision } from "@/lib/mcp-revision";

export function updateMcpApplication(id: number, input: {
  expectedRevision: string;
  stage?: ApplicationStage;
  notes?: string;
  terminal_stage?: ApplicationTerminalStage;
  terminal_reason?: string;
}) {
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new ApplicationInputError("更新投递时必须提供读取到的 revision，避免覆盖较新的修改");
  }
  if (input.stage === undefined && input.notes === undefined && input.terminal_stage === undefined && input.terminal_reason === undefined) {
    throw new ApplicationInputError("请至少提供一个待更新字段");
  }
  return inTransaction(() => {
    const current = getApplicationById(id);
    if (!current) throw new ApplicationInputError("未找到对应投递记录");
    if (mcpRevision("application", current) !== input.expectedRevision) {
      throw new ApplicationInputError("投递记录已更新，请重新读取后再提交");
    }
    if ((input.terminal_stage !== undefined || input.terminal_reason !== undefined) && (input.stage ?? current.stage) !== "rejected") {
      throw new ApplicationInputError("仅终止投递时可设置终止阶段和原因");
    }
    return updateApplication(id, {
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.terminal_stage !== undefined ? { terminal_stage: input.terminal_stage } : {}),
      ...(input.terminal_reason !== undefined ? { terminal_reason: input.terminal_reason } : {}),
    });
  });
}

export function setMcpPreparationStep(applicationId: number, input: {
  expectedRevision: string;
  contextKey: string;
  key: PlanStepKey;
  done: boolean;
}) {
  if (typeof input.contextKey !== "string" || !/^[a-f0-9]{64}$/.test(input.contextKey)) {
    throw new PreparationInputError("请提供读取准备计划时返回的 contextKey");
  }
  if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new PreparationInputError("请提供读取准备计划时返回的 revision");
  }
  return inTransaction(() => {
    const current = getPreparationPlan(applicationId);
    if (mcpRevision("preparation-plan", current) !== input.expectedRevision) {
      throw new PreparationInputError("准备计划已更新，请重新读取后再提交");
    }
    return completePreparationStep(applicationId, input);
  });
}

