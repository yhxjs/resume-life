import { readMcpConfig, permittedMcpTools, toolAccess } from "./config.mjs";
import { randomUUID } from "node:crypto";
import { McpServer, type CallToolResult, type ServerContext, type ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { assertOperationActive, isSqliteBusy, OperationTimeoutError, withOperationLimits, withSqliteLockBudget, withoutWaitingForLock } from "@/lib/operation-deadline";
import { assertDataGeneration, withDataGenerationScope } from "@/lib/data-generation";
import { dataGeneration, getDb } from "@/lib/db";
import { McpOperationError, classifyMcpError, type McpErrorCode } from "@/lib/mcp-errors";
import { recordMcpOperation } from "@/lib/mcp-state";
import { awaitFileExtraction } from "@/lib/mcp-file-extraction-state";
import { logServerError } from "@/lib/server-errors";
import { toolOutputSchema } from "./output-schemas";
import { maintainMcpState } from "@/lib/mcp-generation";
import { startMcpJob } from "@/lib/mcp-jobs";
import { maintainMcpCache } from "@/lib/mcp-cache";
import { MCP_JOB_OPERATIONS, recoverJobResult } from "./job-tools";

type ToolConfig<T extends z.ZodType> = { title: string; description: string; inputSchema: T; annotations: ToolAnnotations };
const schemaJson = (schema: ReturnType<typeof toolOutputSchema>) => z.toJSONSchema(schema);
type Entry = { schema: z.ZodType; output: ReturnType<typeof toolOutputSchema>; outputJson: ReturnType<typeof schemaJson>; run: (input: unknown, ctx: ServerContext) => Promise<CallToolResult>; enabled: boolean; readOnly: boolean };

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

/** Keep SDK discovery/transport; own tools/call so validation failures have the same machine contract. */
export class McpTools {
  private entries = new Map<string, Entry>();
  private enabledNames: Set<string>;
  private maintenanceTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private server: McpServer, private config = readMcpConfig()) {
    this.enabledNames = new Set(permittedMcpTools(config));
    const close = server.server.onclose;
    server.server.onclose = () => { this.closed = true; clearTimeout(this.maintenanceTimer); close?.(); };
  }

  /** Start after the first database operation; discovery and doctor never initialize a database. */
  private scheduleMaintenance(delay = 1000) {
    if (this.closed || this.maintenanceTimer) return;
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = undefined;
      if (this.closed) return;
      try { withoutWaitingForLock(() => { maintainMcpState(); maintainMcpCache(); }); }
      catch (error) { logServerError("mcp.maintenance", error); }
      this.scheduleMaintenance(60_000);
    }, delay);
    this.maintenanceTimer.unref();
  }

  permits(...names: (keyof typeof toolAccess)[]): boolean {
    return names.every(name => this.enabledNames.has(name));
  }
  serverModelsEnabled(): boolean { return this.config.llmEnabled; }

  startJob(input: { operation: keyof typeof MCP_JOB_OPERATIONS; arguments: Record<string, unknown>; timeoutMs?: number }, ctx: ServerContext) {
    const entry = this.entries.get(input.operation);
    const requiredTools: (keyof typeof toolAccess)[] = [...MCP_JOB_OPERATIONS[input.operation]];
    if (input.operation === "capture_project_repository" && input.arguments.baselineCaptureKey !== undefined) requiredTools.push("get_repository_capture");
    if (input.operation === "extract_uploaded_file" && input.arguments.ocrMode === "vision" && !this.config.llmEnabled) throw new McpOperationError("FORBIDDEN", "视觉 OCR 需要显式启用服务端模型");
    if (!entry?.enabled || !requiredTools.every(name => this.permits(name))) throw new McpOperationError("FORBIDDEN", "任务操作或来源工具未获授权");
    if (!inputWithinBudget(input.arguments)) throw new McpOperationError("INVALID_ARGUMENT", "任务参数超过上限");
    const parsed = entry.schema.safeParse(input.arguments);
    if (!parsed.success) throw new McpOperationError("INVALID_ARGUMENT", "任务参数不符合原工具输入契约");
    return startMcpJob({ operation: input.operation, payload: parsed.data as Record<string, unknown>, requiredTools, timeoutMs: input.timeoutMs ?? this.config.timeoutMs }, async signal => {
      const run = () => entry.run(parsed.data, { ...ctx, mcpReq: { ...ctx.mcpReq, signal } });
      const result = await (input.operation === "extract_uploaded_file" ? awaitFileExtraction(run, signal) : run());
      if (result.isError) throw new McpOperationError("INTERNAL", "任务执行未返回有效结果");
      const content = result.content.find(item => item.type === "text");
      const data = JSON.parse(content?.type === "text" ? content.text : "{}");
      entry.output.parse({ ok: true, data, meta: { requestId: randomUUID(), durationMs: 0 } });
      return data as object;
    }, recoverJobResult);
  }

  register<T extends z.ZodType>(name: keyof typeof toolAccess, config: ToolConfig<T>, run: (input: z.output<T>, ctx: ServerContext) => Promise<CallToolResult>) {
    const enabled = this.permits(name);
    const outputSchema = toolOutputSchema(name, capability => this.permits(capability as keyof typeof toolAccess));
    this.entries.set(name, { schema: config.inputSchema, output: outputSchema, outputJson: schemaJson(outputSchema), run: (input, ctx) => run(input as z.output<T>, ctx), enabled, readOnly: toolAccess[name] === "read" });
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
      let databaseUsed = false;
      const timeout = new AbortController();
      const signal = AbortSignal.any([ctx.mcpReq.signal, timeout.signal]);
      const timer = setTimeout(() => timeout.abort(new OperationTimeoutError()), this.config.timeoutMs);
      timer.unref();
      const meta = () => ({ requestId, durationMs: Math.max(0, Math.round(performance.now() - started)) });
      const args = request.params.arguments ?? {};
      const requestedTarget = args.applicationId ?? args.id ?? args.resumeId ?? args.draftId ?? args.parentId ?? args.questionId ?? args.interviewId ?? args.introId ?? args.projectId;
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
          databaseUsed = true;
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
        const structuredContent = entry.output.parse({ ok: true, data, meta: meta() });
        return this.server.server.projectCallToolResult({ ...result, structuredContent }, entry.outputJson);
      } catch (error) {
        const retryable = error instanceof McpOperationError ? error.retryable : undefined;
        const failure = signal.aborted && retryable === undefined ? { code: timeout.signal.aborted ? "TIMEOUT" as const : "CANCELLED" as const,
          message: timeout.signal.aborted ? "操作超时，请稍后重试" : "操作已取消" } : classifyMcpError(error);
        errorCode = failure.code;
        if (failure.code === "INTERNAL") logServerError("mcp.tool", error, { requestId });
        const structuredContent = { ok: false, error: { ...failure, retryable: retryable ?? (failure.code === "TIMEOUT" || failure.code === "BUSY") }, meta: meta() };
        return this.server.server.projectCallToolResult({ isError: true, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent }, entry?.outputJson);
      } finally {
        clearTimeout(timer);
        // Unknown names are caller-controlled and must never become log text.
        recordMcpOperation({ requestId, tool: entry ? request.params.name : "unknown", targetId,
          errorCode, durationMs: performance.now() - started });
        if (databaseUsed) this.scheduleMaintenance();
      }
    });
  }
}
