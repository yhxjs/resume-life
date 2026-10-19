import { AsyncLocalStorage } from "node:async_hooks";
import { ModelProtocolError } from "./model-protocol";
import { ModelInputBudgetError } from "./llm-input-budget";
import { BackupLimitError } from "./backup-limits";

const requestScope = new AsyncLocalStorage<string>();

/** 沿异步调用链传递关联 ID，避免领域层重新生成或串用其他请求的 ID。 */
export function withRequestIdScope<T>(request: Request, handler: () => T): T {
  return requestScope.run(requestIdFrom(request), handler);
}

export function currentRequestId(): string | undefined {
  return requestScope.getStore();
}

const SAFE_PROCESS_SIGNALS = new Set([
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGIOT", "SIGBUS", "SIGFPE",
  "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD",
  "SIGSTKFLT", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU",
  "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPOLL", "SIGPWR", "SIGSYS", "SIGBREAK",
]);
const SAFE_CONTEXT_KEYS = new Set([
  "route",
  "table",
  "resource",
  "resourceId",
  "method",
  "upstreamStatus",
  "dbVersion",
  // 启动摘要与慢路径诊断字段，均为非敏感元数据
  "node",
  "requiredNode",
  "platform",
  "dataDirConfigured",
  "journalMode",
  "storageWritable",
  "resultCount",
  "queryLength",
  "thresholdMs",
  // LLM 调用日志与过期清理的诊断字段：调用状态、重试次数与删除条数，都不含正文
  "status",
  "attempt",
  "removed",
  "retentionDays",
  // LLM 调用日志的定位字段：任务名与协议名都是固定枚举，errorCode 也是内部枚举
  // （http_429 / timeout / network / protocol / unknown / stream_unsupported）。
  // 刻意不含 model：它是设置页的自由文本，且 llm_call_log 表已单独持久化，日志里不必再留一份。
  "task",
  "format",
  "errorCode",
  "pageCount",
  // 解析沙箱仅保留进程退出元数据，不接受 stderr 正文。
  "exitCode",
  "signal",
]);

const DIAGNOSTIC_STAGES = ["database-open", "database-query", "database-version", "database-wal", "storage-write", "restore-staging"] as const;
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];
const SAFE_DIAGNOSTIC_STAGES = new Set<string>(DIAGNOSTIC_STAGES);
const SAFE_ERROR_CODES = new Set([
  "ENOSPC", "EACCES", "EPERM", "ENOENT", "EROFS", "EMFILE", "EPIPE",
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

export interface ServerErrorLogOptions {
  requestId?: string;
  status?: number;
  durationMs?: number;
  context?: Record<string, unknown>;
  /** 固定的内部失败阶段；运行时仍验证白名单，不接受任意诊断文本。 */
  stage?: DiagnosticStage;
}

function safeRequestId(value?: string): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : globalThis.crypto.randomUUID();
}

function errorTypeOf(error: unknown): string {
  // 按可信类型分类，不读取可能夹带个人资料的 error.name。
  if (error instanceof ModelProtocolError) return "ModelProtocolError";
  if (error instanceof ModelInputBudgetError) return "ModelInputBudgetError";
  if (error instanceof BackupLimitError) return "BackupLimitError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof Error) return "Error";
  if (error === null) return "null";
  return typeof error;
}

function safeErrorCode(error: unknown): string {
  let current = error;
  // fetch 的系统错误通常在 cause 中；有限深度同时防止循环 cause 无限遍历。
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object") break;
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && SAFE_ERROR_CODES.has(code)) return code;
    if (code === "ERR_SQLITE_ERROR") {
      const message = current instanceof Error ? current.message : "";
      return /^(?:UNIQUE|CHECK|NOT NULL|FOREIGN KEY|PRIMARY KEY) constraint failed(?::|$)/.test(message)
        ? "SQLITE_CONSTRAINT" : "SQLITE_ERROR";
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return "unknown";
}

function safeContext(input?: Record<string, unknown>): Record<string, string | number | boolean | null> | undefined {
  if (!input) return undefined;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    if (key === "pageCount" && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5)) continue;
    if (key === "exitCode" && value !== null && (typeof value !== "number" || !Number.isInteger(value))) continue;
    if (key === "signal" && value !== null && (typeof value !== "string" || !SAFE_PROCESS_SIGNALS.has(value))) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = typeof value === "string" ? value.slice(0, 160) : value;
    }
  }
  return Object.keys(output).length ? output : undefined;
}

/**
 * 只记录诊断元数据，不记录异常 message/stack、请求正文、模型输出、密钥或个人资料。
 * 返回 requestId，调用方可把它放入稳定错误响应供本地排障关联。
 */
export function logServerError(operation: string, error: unknown, options: ServerErrorLogOptions = {}): string {
  const requestId = safeRequestId(options.requestId);
  const payload = {
    operation,
    requestId,
    status: options.status ?? 500,
    ...(Number.isFinite(options.durationMs) ? { durationMs: Math.max(0, Math.round(options.durationMs!)) } : {}),
    errorType: errorTypeOf(error),
    errorCode: safeErrorCode(error),
    ...(options.stage && SAFE_DIAGNOSTIC_STAGES.has(options.stage) ? { stage: options.stage } : {}),
    ...(safeContext(options.context) ? { context: safeContext(options.context) } : {}),
  };
  console.error(`[server-error] ${JSON.stringify(payload)}`);
  return requestId;
}

const REQUEST_IDS = new WeakMap<Request, string>();

/**
 * 同一个 Request 对象始终得到同一个 requestId。
 *
 * 客户端没带 x-request-id 时这里会现生成 UUID；若不按对象缓存，处理链上
 * 每个调用点（路由包装、SSE 兜底、LLM 日志）都会各生成一个，于是同一次请求
 * 在日志里散成多个互不相干的 ID，客户端拿到的那一个也搜不到任何东西。
 */
export function requestIdFrom(request?: Request): string {
  if (!request) return safeRequestId(undefined);
  const cached = REQUEST_IDS.get(request);
  if (cached) return cached;
  const requestId = safeRequestId(request.headers.get("x-request-id") ?? undefined);
  REQUEST_IDS.set(request, requestId);
  return requestId;
}

export type ServerLogLevel = "info" | "warn";

/**
 * 成功路径与慢路径的结构化诊断日志，与 logServerError 共用字段白名单，
 * 因此同样不会记录请求正文、模型输出、密钥或个人资料。
 */
export function logServerEvent(
  level: ServerLogLevel,
  operation: string,
  options: { requestId?: string; durationMs?: number; context?: Record<string, unknown> } = {}
): void {
  const context = safeContext(options.context);
  const payload = {
    level,
    operation,
    ...(options.requestId ? { requestId: safeRequestId(options.requestId) } : {}),
    ...(Number.isFinite(options.durationMs) ? { durationMs: Math.max(0, Math.round(options.durationMs!)) } : {}),
    ...(context ? { context } : {}),
  };
  const line = `[server-${level}] ${JSON.stringify(payload)}`;
  if (level === "warn") console.warn(line);
  else console.info(line);
}

/**
 * 备份清理失败的专用诊断行。与 logServerError/logServerEvent 同构的单行 JSON
 * （errorType/errorCode 走同一套白名单脱敏，不落自由文本 message），但固定走
 * console.error 通道：清理失败永远伴随一次主错误，两条诊断出现在同一捕获流里，
 * 才能被 requestId 关联检索（TROUBLESHOOTING §1 的排查入口）。
 */
export function logCleanupFailure(options: {
  requestId?: string;
  error: unknown;
  context: { operation: string; resource: string };
}): void {
  const payload = {
    level: "warn",
    operation: "backup.cleanup",
    ...(options.requestId ? { requestId: safeRequestId(options.requestId) } : {}),
    errorType: errorTypeOf(options.error),
    errorCode: safeErrorCode(options.error),
    context: { operation: options.context.operation, resource: options.context.resource },
  };
  console.error(`[server-warn] ${JSON.stringify(payload)}`);
}
