import { ApplicationInputError } from "./applications";
import { PreparationInputError } from "./application-preparation";
import { OperationTimeoutError, isSqliteBusy } from "./operation-deadline";
import { DataGenerationConflictError } from "./data-generation";
import { ResumeContextError, ResumeNotFoundError } from "./resume-errors";
import { ResumeVersionError } from "./resume-versions";
import { InterviewReviewError } from "./application-interview-review";
import { LlmResponseError } from "./llm-adapter";
import { LlmBusyError, LlmConfigError, LlmHttpError, LlmInvalidJsonError, LlmTimeoutError } from "./llm";
import { SettingsSecretError } from "./secret-store";
import { BackupLimitError } from "./backup-limits";
import { ModelInputBudgetError } from "./llm-input-budget";
import { ReviewError } from "./spaced-repetition-cards";
import { NotebookMutationError } from "./notebook-storage";
import { DrillGradeError } from "./drill-grading";
import { ProjectNotFoundError } from "./projects";
import { ProjectSummaryCorruptError } from "./summary";
import { DocumentTableProvenanceError } from "./document-table-provenance";
import { ModelProtocolError } from "./model-protocol";
import { ProjectSummaryHistoryError } from "./project-summary-history";
import { InterviewCommandError } from "./interview-commands/errors";
import { DefenseDrillSaveError } from "./resume-defense";
import { NegotiationBudgetError } from "./salary-negotiation-llm";

/** Stable machine codes for MCP clients; messages contain no model/provider payloads. */
export const MCP_ERROR_CODES = ["INVALID_ARGUMENT", "NOT_FOUND", "CONFLICT", "FORBIDDEN", "CONFIGURATION", "BUSY", "CANCELLED", "TIMEOUT", "MODEL_OUTPUT", "INTERNAL"] as const;
export type McpErrorCode = typeof MCP_ERROR_CODES[number];

export class McpOperationError extends Error {
  readonly retryable?: boolean;
  constructor(public code: McpErrorCode, message: string, options: ErrorOptions & { retryable?: boolean } = {}) {
    super(message, options);
    this.retryable = options.retryable;
  }
}

export function classifyMcpError(error: unknown): { code: McpErrorCode; message: string } {
  if (error instanceof McpOperationError) return { code: error.code, message: error.message };
  if (error instanceof OperationTimeoutError) return { code: "TIMEOUT", message: error.message };
  if (isSqliteBusy(error)) return { code: "BUSY", message: "数据库正忙，请稍后重试" };
  if (error instanceof DataGenerationConflictError) return { code: "CONFLICT", message: error.message };
  if (error instanceof BackupLimitError) return { code: "INVALID_ARGUMENT", message: "资料超过可完整保存的大小上限，请精简后重试" };
  if (error instanceof LlmInvalidJsonError) return { code: "MODEL_OUTPUT", message: "模型返回的内容不是有效 JSON，未保存业务资料" };
  if (error instanceof LlmResponseError && error.code !== "provider") return { code: "MODEL_OUTPUT", message: "模型没有返回完整可用的结果，未保存业务资料" };
  if (error instanceof LlmBusyError || (error instanceof LlmHttpError && error.status === 429)) return { code: "BUSY", message: "模型服务繁忙，请稍后重试" };
  if (error instanceof LlmTimeoutError || (error instanceof LlmHttpError && (error.status === 408 || error.status === 504))) return { code: "TIMEOUT", message: "模型请求超时，请稍后重试" };
  if (error instanceof LlmHttpError && (error.status === 401 || error.status === 403)) return { code: "CONFIGURATION", message: "模型服务拒绝授权，请检查模型凭证与访问权限" };
  if (error instanceof SettingsSecretError) return { code: "CONFIGURATION", message: "无法读取模型凭证，请核对 MCP 与网页端的 RESUME_LIFE_SETTINGS_KEY" };
  if (error instanceof LlmConfigError) return { code: "CONFIGURATION", message: error.message };
  if (error instanceof ResumeNotFoundError || error instanceof ProjectNotFoundError) return { code: "NOT_FOUND", message: error.message };
  if (error instanceof ProjectSummaryCorruptError || error instanceof DocumentTableProvenanceError) return { code: "INVALID_ARGUMENT", message: "项目资料异常，不能用作评分依据" };
  if (error instanceof ResumeVersionError || error instanceof InterviewReviewError || error instanceof PreparationInputError || error instanceof ReviewError || error instanceof NotebookMutationError || error instanceof DrillGradeError || error instanceof ProjectSummaryHistoryError || error instanceof InterviewCommandError || error instanceof DefenseDrillSaveError) {
    return { code: error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "INVALID_ARGUMENT", message: error.message };
  }
  if (error instanceof ApplicationInputError || error instanceof ResumeContextError || error instanceof ModelInputBudgetError || error instanceof ModelProtocolError || error instanceof NegotiationBudgetError) return { code: "INVALID_ARGUMENT", message: error.message };
  return { code: "INTERNAL", message: "MCP 操作失败，请按 requestId 检查本机日志。" };
}
