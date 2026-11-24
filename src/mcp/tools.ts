import { readMcpConfig, toolAccess } from "./config.mjs";
import { randomUUID } from "node:crypto";
import { McpServer, type CallToolResult, type ServerContext, type ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApplicationInputError } from "@/lib/applications";
import { PreparationInputError } from "@/lib/application-preparation";
import { assertOperationActive, isSqliteBusy, OperationTimeoutError, withOperationLimits, withSqliteLockBudget } from "@/lib/operation-deadline";
import { assertDataGeneration, DataGenerationConflictError, withDataGenerationScope } from "@/lib/data-generation";
import { dataGeneration, getDb } from "@/lib/db";
import { ResumeContextError, ResumeNotFoundError } from "@/lib/resume-errors";
import { ResumeVersionError } from "@/lib/resume-versions";
import { InterviewReviewError } from "@/lib/application-interview-review";
import { LlmResponseError } from "@/lib/llm-adapter";
import { LlmBusyError, LlmConfigError, LlmHttpError, LlmInvalidJsonError, LlmTimeoutError } from "@/lib/llm";
import { SettingsSecretError } from "@/lib/secret-store";
import { BackupLimitError } from "@/lib/backup-limits";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { McpOperationError, MCP_ERROR_CODES, type McpErrorCode } from "@/lib/mcp-errors";
import { recordMcpOperation } from "@/lib/mcp-state";
import { logServerError } from "@/lib/server-errors";

const outputSchema = z.object({
  ok: z.boolean(),
  data: z.record(z.string(), z.json()).optional(),
  error: z.object({ code: z.enum(MCP_ERROR_CODES), message: z.string(), retryable: z.boolean() }).optional(),
  meta: z.object({ requestId: z.string(), durationMs: z.number() }),
});
const outputJsonSchema = z.toJSONSchema(outputSchema);
type ToolConfig<T extends z.ZodType> = { title: string; description: string; inputSchema: T; annotations: ToolAnnotations };
type Entry = { schema: z.ZodType; run: (input: unknown, ctx: ServerContext) => Promise<CallToolResult>; enabled: boolean; readOnly: boolean };

function inputWithinBudget(input: unknown): boolean {
  const pending: unknown[] = [input];
  let count = 0;
  while (pending.length) {
    const value = pending.pop();
    if (++count > 1_000) return false;
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        pending.push(item);
        if (pending.length + count > 1_000) return false;
      }
    }
    if (pending.length + count > 1_000) return false;
  }
  return JSON.stringify(input).length <= 128_000;
}

function classify(error: unknown): { code: McpErrorCode; message: string } {
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
  if (error instanceof ResumeNotFoundError) return { code: "NOT_FOUND", message: error.message };
  if (error instanceof ResumeVersionError || error instanceof InterviewReviewError || error instanceof PreparationInputError) {
    return { code: error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : "INVALID_ARGUMENT", message: error.message };
  }
  if (error instanceof ApplicationInputError || error instanceof ResumeContextError || error instanceof ModelInputBudgetError) {
    return { code: "INVALID_ARGUMENT", message: error.message };
  }
  return { code: "INTERNAL", message: "MCP 操作失败，请按 requestId 检查本机日志。" };
}

/** Keep SDK discovery/transport; own tools/call so validation failures have the same machine contract. */
export class McpTools {
  private entries = new Map<string, Entry>();
  constructor(private server: McpServer, private config = readMcpConfig()) {}

  permits(...names: (keyof typeof toolAccess)[]): boolean {
    const { allowlist, writeEnabled, llmEnabled } = this.config;
    return names.every(name => (!allowlist || allowlist.has(name)) && (toolAccess[name] === "read" ||
      (toolAccess[name] === "write" && writeEnabled) || (toolAccess[name] === "llm" && llmEnabled)));
  }

  register<T extends z.ZodType>(name: keyof typeof toolAccess, config: ToolConfig<T>, run: (input: z.output<T>, ctx: ServerContext) => Promise<CallToolResult>) {
    const enabled = this.permits(name);
    this.entries.set(name, { schema: config.inputSchema, run: (input, ctx) => run(input as z.output<T>, ctx), enabled, readOnly: toolAccess[name] === "read" });
    if (enabled) this.server.registerTool(name, { ...config, inputSchema: config.inputSchema as z.ZodType, outputSchema }, async () => {
      throw new Error("MCP tools/call handler has not been installed");
    });
  }

  install() {
    if (Object.keys(toolAccess).some(name => !this.entries.has(name))) throw new Error("MCP 工具注册与权限清单不一致");
    this.server.server.registerCapabilities({ tools: {} });
    // Explicit handler also supports an intentionally empty allowlist.
    if (![...this.entries.values()].some(entry => entry.enabled)) this.server.server.setRequestHandler("tools/list", () => ({ tools: [] }));
    this.server.server.setRequestHandler("tools/call", async (request, ctx) => {
      const requestId = randomUUID();
      const started = performance.now();
      const entry = this.entries.get(request.params.name);
      let errorCode: McpErrorCode | undefined;
      const timeout = new AbortController();
      const signal = AbortSignal.any([ctx.mcpReq.signal, timeout.signal]);
      const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
      timer.unref();
      const meta = () => ({ requestId, durationMs: Math.max(0, Math.round(performance.now() - started)) });
      const args = request.params.arguments ?? {};
      const requestedTarget = args.applicationId ?? args.id ?? args.resumeId ?? args.draftId ?? args.parentId;
      let targetId = typeof requestedTarget === "number" && Number.isSafeInteger(requestedTarget) && requestedTarget > 0 ? requestedTarget : null;
      try {
        if (!entry) throw new McpOperationError("NOT_FOUND", "工具不存在");
        if (!entry.enabled) throw new McpOperationError("FORBIDDEN", "工具未获授权，请检查能力开关和工具白名单");
        if (!inputWithinBudget(args)) throw new McpOperationError("INVALID_ARGUMENT", "工具参数超过大小或结构上限");
        const parsed = entry.schema.safeParse(args);
        if (!parsed.success) throw new McpOperationError("INVALID_ARGUMENT", "工具参数无效，请按工具 inputSchema 检查字段、类型和范围");
        const result = await withOperationLimits({ deadline: started + this.config.timeoutMs, signal }, async () => {
          assertOperationActive();
          const db = getDb();
          try {
            // Cover the initial generation read and synchronous handler work even in rollback-journal mode.
            // Restore busy_timeout as soon as the handler yields; later async writes obtain a fresh budget.
            return await withSqliteLockBudget(db, () => withDataGenerationScope(async () => {
              const value = await entry.run(parsed.data, { ...ctx, mcpReq: { ...ctx.mcpReq, signal } });
              // Mutations validate in the committing transaction. Never retroactively time out a commit.
              if (entry.readOnly) { assertDataGeneration(); assertOperationActive(); }
              return value;
            }, dataGeneration(db)));
          } catch (error) {
            // An async handler delivers a synchronous SQLITE_BUSY as a rejected promise.
            if (isSqliteBusy(error)) assertOperationActive();
            throw error;
          }
        });
        if (result.isError) throw new McpOperationError("INVALID_ARGUMENT", result.content.find(item => item.type === "text")?.text ?? "操作失败");
        const text = result.content.find(item => item.type === "text");
        const data: unknown = text?.type === "text" ? JSON.parse(text.text) : {};
        if (data && typeof data === "object" && "id" in data && typeof data.id === "number" && Number.isSafeInteger(data.id)) targetId = data.id;
        const structuredContent = outputSchema.parse({ ok: true, data, meta: meta() });
        return this.server.server.projectCallToolResult({ ...result, structuredContent }, outputJsonSchema);
      } catch (error) {
        const failure = signal.aborted ? { code: timeout.signal.aborted ? "TIMEOUT" as const : "CANCELLED" as const,
          message: timeout.signal.aborted ? "操作超时，请稍后重试" : "操作已取消" } : classify(error);
        errorCode = failure.code;
        if (failure.code === "INTERNAL") logServerError("mcp.tool", error, { requestId });
        const structuredContent = { ok: false, error: { ...failure, retryable: failure.code === "TIMEOUT" || failure.code === "BUSY" }, meta: meta() };
        return this.server.server.projectCallToolResult({ isError: true, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent }, outputJsonSchema);
      } finally {
        clearTimeout(timer);
        // Unknown names are caller-controlled and must never become log text.
        recordMcpOperation({ requestId, tool: entry ? request.params.name : "unknown", targetId,
          errorCode, durationMs: performance.now() - started });
      }
    });
  }
}
