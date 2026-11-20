import { readSettings, type ApiFormat } from "./settings";
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens } from "./settings-constants";
import { checkModelInput } from "./llm-input-budget";
import { DuplicateModelJsonKeyError, parseModelJson } from "./model-json";
import type { LlmSource } from "./llm-source";
import { recordLlmCall } from "./llm-call-log";
import { logServerEvent } from "./server-errors";
import { parseHttpBaseUrl, type readModelSettingsRequest } from "./settings-request";
import { proxyConfigFromSettings, type ProxyConfig } from "./proxy-config";
import { proxyFetchInit } from "./proxy-dispatcher";
import { EMPTY_USAGE, mergeUsage, parseNonStreamUsage, type LlmUsage } from "./llm-adapter";
import { acquireLlmLease, releaseLlmLease } from "./shared-budgets";
import { observeLlmRequest, type LlmProgressObserver } from "./llm-request-progress";
import {
  buildChatUrl,
  buildHeaders,
  buildRequestBody,
  handleSsePayload,
  LlmResponseError,
  parseNonStreamReply,
  type ChatMessage,
} from "./llm-adapter";

export type LlmTask = "parse" | "summary" | "question" | "evaluate";

export const TASK_LABELS: Record<LlmTask, string> = {
  parse: "解析",
  summary: "总结",
  question: "出题",
  evaluate: "评分",
};

export class LlmConfigError extends Error {}
export class LlmBusyError extends LlmConfigError {}

export type { ChatMessage };

function resolveModel(task: LlmTask): {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ApiFormat;
  proxy: ProxyConfig;
  maxOutputTokens: number;
} {
  const s = readSettings();
  const fallback =
    s.model_parse || s.model_summary || s.model_question || s.model_evaluate;
  const model = s[`model_${task}`] || fallback;
  if (!s.base_url || !s.api_key || !model) {
    throw new LlmConfigError(
      `尚未配置好「${TASK_LABELS[task]}」所需的 LLM 服务，请先到「设置」页填写 Base URL、API Key 与模型名。`
    );
  }
  try { parseHttpBaseUrl(s.base_url.trim()); }
  catch { throw new LlmConfigError("模型服务地址不安全，请使用 HTTPS 或本机回环 HTTP。"); }
  const format: ApiFormat = (s.api_format as ApiFormat) || "openai_chat";
  const maxOutputTokens = resolveMaxOutputTokens(s.max_output_tokens);
  return { baseUrl: s.base_url.trim(), apiKey: s.api_key.trim(), model, format, proxy: proxyConfigFromSettings(s), maxOutputTokens };
}

const LLM_IDLE_TIMEOUT_MS = 60000; // 连接、首块数据及相邻数据块之间的最大静默时间
const LLM_TOTAL_TIMEOUT_MS = 300000;
export const LLM_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 非流式响应体及聚合后的可见正文
// SSE 每片重复携带元数据，也可能包含不对外显示的推理；传输预算单独计，未知事件与心跳同样消耗。
export const LLM_MAX_SSE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const LLM_MAX_SSE_FRAME_BYTES = 256 * 1024;
const LLM_MAX_RETRIES = 2; // 自动重试上限，至少退避 1s、2s，并遵守 Retry-After；整个调用仍受总截止时间约束
// useStream 在整个调用内只会从 true 降为 false，400 降级最多增加一次请求。
const LLM_CALL_TIMEOUT_MS = (LLM_MAX_RETRIES + 2) * LLM_TOTAL_TIMEOUT_MS + 1000 * (2 ** LLM_MAX_RETRIES - 1);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 本进程快速拒绝上限；共享 lease 在数据目录 sidecar 中提供跨进程总量上限。
 *
 * chat 与 chatStream 共用 3 个名额，整个调用及其重试都占用同一个名额。
 * 超限立即拒绝，不排队且不发送额外上游请求；调用结束或失败后归还名额。
 * 这限制多标签页跨功能并行调用对本机模型及云端配额的压力，sidecar 令牌同时覆盖多个 Node 进程。
 *
 * 既有的 acquireCommandLock 按实体 key 去重（interview-answer:${id}），
 * 不同实体、不同功能之间不互斥，与这里的进程级总量上限互补。
 */
export const LLM_MAX_CONCURRENT = 3;
const LLM_LEASE_MS = LLM_CALL_TIMEOUT_MS + LLM_IDLE_TIMEOUT_MS; // 租期晚于完整调用截止，预留清理时间

let llmInFlight = 0;

/** HTTP-date 支持三种标准格式；UTC 字段回验避免把不存在的日期规范化成未来等待。 */
function retryAfterDelay(value: string | null): number {
  const text = value?.trim() ?? "";
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  let parts: string[] | null = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(text)
    ?? /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(text);
  if (!parts) {
    const legacy = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(text);
    if (!legacy) return 0;
    parts = [legacy[0]!, legacy[1]!, legacy[3]!, legacy[2]!, legacy[5]!, legacy[4]!];
  }
  const day = Number(parts[2]);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(parts[3]!);
  let year = Number(parts[4]);
  if (parts[4]!.length === 2) {
    const currentYear = new Date().getUTCFullYear();
    year += Math.floor(currentYear / 100) * 100;
    if (year > currentYear + 50) year -= 100;
  }
  const [hour, minute, second] = parts[5]!.split(":").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (month < 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second
    || ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts[1]!.slice(0, 3)) !== date.getUTCDay()) return 0;
  return date.getTime() - Date.now();
}

export class LlmHttpError extends Error {
  status: number;
  retryAfterMs: number;
  constructor(status: number, retryAfter: string | null) {
    super(`LLM 请求失败（HTTP ${status}）`);
    this.status = status;
    const delay = retryAfterDelay(retryAfter);
    // 过长等待只会触发既有调用截止，不能让 setTimeout 溢出后提前重试。
    this.retryAfterMs = Number.isNaN(delay) ? 0 : Math.min(LLM_CALL_TIMEOUT_MS, Math.max(0, delay));
  }
}

export class LlmTimeoutError extends Error {}

/** requireJson 校验失败：回复不是有效且键唯一的 JSON。未向客户端输出过内容时可重试 */
class LlmInvalidJsonError extends Error {
  constructor() {
    super("AI 返回的内容不是有效 JSON，请重试或核对模型输出格式");
  }
}

type LogFn = (entry: { status: string; errorCode?: string; attempt?: number }) => void;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("客户端已取消操作"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 发起一次补全请求（流式 SSE 或非流式），聚合出完整文本；空闲/总超时通过 abort 中断 */
async function requestOnce(args: {
  format: ApiFormat;
  model: string;
  url: string;
  apiKey: string;
  proxy: ProxyConfig;
  messages: ChatMessage[];
  maxTokens?: number;
  useStream: boolean;
  attempt: number;
  requestIndex: number;
  logLlm: LogFn;
  onDelta?: (delta: string) => void;
  onUsage?: (usage: LlmUsage) => void;
  onHttpStatus?: ChatStreamOptions["onHttpStatus"];
  onRequestProgress?: LlmProgressObserver;
  signal?: AbortSignal;
}): Promise<{ content: string; usage: LlmUsage }> {
  const { format, model, url, apiKey, proxy, messages, maxTokens, useStream, attempt, logLlm, onDelta, signal } = args;
  let usage = EMPTY_USAGE;
  const collectUsage = (delta: Partial<LlmUsage>) => {
    usage = mergeUsage(usage, delta);
    args.onUsage?.(usage);
  };
  signal?.throwIfAborted();
  const controller = new AbortController();
  let abortKind: "idle" | "total" | "client" | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const abortRequest = (kind: NonNullable<typeof abortKind>, reason?: unknown) => {
    // AbortController preserves the first reason; diagnostics must do the same
    // while fetch/reader cancellation is still settling.
    if (controller.signal.aborted) return;
    abortKind = kind;
    controller.abort(reason);
  };
  const onClientAbort = () => {
    abortRequest("client", signal?.reason);
  };
  signal?.addEventListener("abort", onClientAbort);

  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortRequest("idle");
    }, LLM_IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => {
    abortRequest("total");
  }, LLM_TOTAL_TIMEOUT_MS);
  bumpIdle();
  const progress = observeLlmRequest({ requestIndex: args.requestIndex, attempt, stream: useStream }, args.onRequestProgress);
  let responseComplete = false;

  try {
    const res = await fetch(url, {
      ...proxyFetchInit(proxy),
      method: "POST",
      headers: {
        ...buildHeaders(format, apiKey),
        Accept: useStream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(
        buildRequestBody({
          format,
          model,
          messages,
          maxTokens,
          stream: useStream,
        })
      ),
      signal: controller.signal,
      redirect: "manual",
    });
    progress?.headers(res.status);
    // 只观察真实响应状态；观察失败不能改变请求结果、重试或取消语义。
    if (args.onHttpStatus) {
      try { void Promise.resolve(args.onHttpStatus(res.status)).catch(() => {}); } catch {}
    }
    logLlm({ status: String(res.status), attempt });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new LlmHttpError(res.status, res.headers.get("Retry-After"));
    }
    const content = (
      useStream
        ? await readSseContent(res, format, bumpIdle, onDelta, collectUsage, progress)
        : await readJsonContent(res, format, bumpIdle, collectUsage, progress)
    ).trim();
    signal?.throwIfAborted();
    if (!content) throw new LlmResponseError("LLM 返回了空内容", "protocol");
    responseComplete = true;
    return { content, usage };
  } catch (err) {
    if (abortKind === "client") {
      if (signal?.reason instanceof LlmTimeoutError) throw signal.reason;
      throw new Error("客户端已取消操作");
    }
    if (abortKind) {
      throw new LlmTimeoutError(
        abortKind === "idle"
          ? `LLM 流式响应中断（${LLM_IDLE_TIMEOUT_MS / 1000} 秒未收到新数据），请检查服务是否可用后重试`
          : `LLM 请求超时（${LLM_TOTAL_TIMEOUT_MS / 1000} 秒未完成），请检查服务是否可用后重试`
      );
    }
    throw err;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onClientAbort);
    progress?.end(responseComplete ? "complete" : "error", abortKind ?? null);
  }
}

/** 解码错误是提供方协议损坏；不能当作可重试 TypeError，也不能静默替换原文。 */
function decodeModelUtf8(decoder: TextDecoder, bytes?: Uint8Array, stream = false): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new LlmResponseError("LLM 响应不是有效 UTF-8 编码，请核对模型服务返回格式", "protocol");
  }
}

async function readJsonContent(
  res: Response,
  format: ApiFormat,
  bumpIdle: () => void,
  onUsage: (usage: Partial<LlmUsage>) => void,
  progress?: ReturnType<typeof observeLlmRequest>,
): Promise<string> {
  if (!res.body) throw new LlmResponseError("LLM 响应缺少响应体", "protocol");
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      progress?.bytes(value.byteLength);
      if (value.byteLength > 0) bumpIdle();
      bytes += value.byteLength;
      if (bytes > LLM_MAX_RESPONSE_BYTES) {
        throw new LlmResponseError("LLM 响应超过字节上限", "protocol");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const decoded = decodeModelUtf8(new TextDecoder("utf-8", { fatal: true }), Buffer.concat(chunks, bytes));
  let data: unknown;
  try {
    data = JSON.parse(decoded);
  } catch {
    // JSON.parse 的异常可能包含响应正文；不要向调用方或日志透出。
    throw new LlmResponseError("LLM 响应不是有效 JSON", "protocol");
  }
  onUsage(parseNonStreamUsage(format, data));
  const content = parseNonStreamReply(format, data);
  progress?.content(Buffer.byteLength(content, "utf8"));
  return content;
}

/** 解析 SSE 流，聚合文本内容并支持向外实时逐块输出 */
async function readSseContent(
  res: Response,
  format: ApiFormat,
  bumpIdle: () => void,
  onDelta?: (delta: string) => void,
  onUsage?: (usage: Partial<LlmUsage>) => void,
  progress?: ReturnType<typeof observeLlmRequest>,
): Promise<string> {
  if (!res.body) throw new Error("LLM 流式响应缺少响应体");
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let content = "";
  let responseBytes = 0;
  let contentBytes = 0;
  let frameBytes = 0;
  let dataLines: string[] = [];
  let skipLineFeed = false;

  const dispatchEvent = (): "done" | undefined => {
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    frameBytes = 0;
    if (!payload) return;
    return handleSsePayload(format, payload, (deltaText) => {
      // JSON deltas can split a UTF-16 surrogate pair even though the wire is
      // valid UTF-8. Count the joined text, not two replacement characters.
      const previousCode = content.charCodeAt(content.length - 1);
      const nextCode = deltaText.charCodeAt(0);
      const joinsSurrogatePair = previousCode >= 0xd800 && previousCode <= 0xdbff
        && nextCode >= 0xdc00 && nextCode <= 0xdfff;
      const deltaBytes = Buffer.byteLength(deltaText, "utf8") - (joinsSurrogatePair ? 2 : 0);
      contentBytes += deltaBytes;
      progress?.content(deltaBytes);
      if (contentBytes > LLM_MAX_RESPONSE_BYTES) {
        throw new LlmResponseError("LLM 响应内容超过字节上限", "protocol");
      }
      content += deltaText;
      onDelta?.(deltaText);
    }, onUsage);
  };

  const handleLine = (line: string, separatorBytes = 0): "done" | undefined => {
    frameBytes += Buffer.byteLength(line, "utf8") + separatorBytes;
    if (frameBytes > LLM_MAX_SSE_FRAME_BYTES) {
      throw new LlmResponseError("LLM SSE 单帧超过字节上限", "protocol");
    }
    if (!line) return dispatchEvent();
    // 同一事件的 data 字段以换行连接；注释、event、id 等不参与 JSON 内容。
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      const receivedBytes = value?.byteLength ?? 0;
      // Empty transport chunks are not activity, matching non-streaming reads.
      if (receivedBytes > 0) bumpIdle();
      progress?.bytes(receivedBytes);
      responseBytes += receivedBytes;
      if (responseBytes > LLM_MAX_SSE_RESPONSE_BYTES) {
        throw new LlmResponseError("LLM 响应超过字节上限", "protocol");
      }
      buffer += decodeModelUtf8(decoder, done ? undefined : value, !done);
      let nl: number;
      // CR 立即结束一行，不等待网关关闭连接；跨块的可选 LF 不再形成空行。
      if (skipLineFeed && buffer.length) {
        if (buffer[0] === "\n") buffer = buffer.slice(1);
        skipLineFeed = false;
      }
      while ((nl = buffer.search(/[\r\n]/)) !== -1) {
        const isCarriageReturn = buffer[nl] === "\r";
        const separatorBytes = isCarriageReturn && buffer[nl + 1] === "\n" ? 2 : 1;
        skipLineFeed = isCarriageReturn && nl === buffer.length - 1;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + separatorBytes);
        // 单帧预算按规范化为 LF 后的事件计算；原始网络字节另受响应总预算限制。
        if (handleLine(line, 1) === "done") return content;
      }
      if (frameBytes + Buffer.byteLength(buffer, "utf8") > LLM_MAX_SSE_FRAME_BYTES) {
        throw new LlmResponseError("LLM SSE 单帧超过字节上限", "protocol");
      }
      if (done) break;
    }
    if (buffer) {
      if (handleLine(buffer) === "done") return content;
    }
    // 保留网关在最后一帧后直接 EOF 的兼容；仍须收到协议完成事件。
    if (dispatchEvent() === "done") return content;
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new LlmResponseError("LLM 流式响应意外中断，未收到完成事件", "protocol", "interrupted");
}

/** 调用 LLM 接口（SSE 流式传输，超时自动中断，失败自动重试），返回完整回复文本 */
export async function chat(
  task: LlmTask,
  messages: ChatMessage[],
  opts?: ChatStreamOptions
): Promise<string> {
  return chatStream(task, messages, undefined, opts);
}

export type ChatStreamOptions = {
  maxTokens?: number;
  signal?: AbortSignal;
  source?: LlmSource;
  /** 每次收到 HTTP 响应时同步通知数值状态；不等待异步观察，隔离其异常。 */
  onHttpStatus?: (status: number) => void | Promise<void>;
  /** Per-request metadata, including strict-JSON buffering; never text. Observer failures are isolated. */
  onRequestProgress?: LlmProgressObserver;
  /**
   * 进入终态计量时通知一次已观测的累计用量；可能只覆盖部分尝试。
   * 未进入该路径的前置失败不通知；三项 null 不证明请求已发出。
   * 传入独立副本，隔离同步/异步异常且不等待观察结果。
   */
  onUsage?: (usage: LlmUsage) => void | Promise<void>;
  /** 关联 ID，随请求从路由层透传下来，用于把 LLM 层日志与用户看到的报错串起来 */
  requestId?: string;
  /** 未保存配置的连接测试：固定非流式、1024 输出 token、15 秒截止且不自动重试。 */
  connectionTest?: ReturnType<typeof readModelSettingsRequest>;
  /**
   * true 使用 extractJson 容错（容忍围栏与前后杂文）；"strict" 要求整段为纯 JSON。
   * 两者均拒绝同一对象内重复的键，避免字段被静默覆盖；不改变历史数据读取。
   * 不满足时按可重试错误自动重新生成，总尝试次数与网络重试共享上限；
   * 上游仍以流式读取，但通过 JSON 校验后才一次性调用 onDelta，避免无效片段外发。
   * 仅校验 JSON 语法，业务字段仍由调用方校验。
   */
  requireJson?: boolean | "strict";
};

/**
 * 流式调用 LLM 接口：
 * 通过 onDelta 回调输出文本，并在结束时返回完整的聚合文本。
 * 默认实时逐块输出；requireJson 模式在完整 JSON 校验通过后一次性输出。
 *
 * 入口处有本进程快速闸门和共享 sidecar lease：超限时立刻失败，不排队。排队会让用户盯着一个没有
 * 任何反馈的界面等几十秒，最后收到的还是「请检查服务是否可用」这种误导性文案；
 * 快速失败至少把真实原因（此刻同时在跑的模型调用太多）如实说出来。
 */
export async function chatStream(
  task: LlmTask,
  messages: ChatMessage[],
  onDelta?: (delta: string) => void,
  opts?: ChatStreamOptions
): Promise<string> {
  opts?.signal?.throwIfAborted();
  if (llmInFlight >= LLM_MAX_CONCURRENT) {
    throw new LlmBusyError(
      `同时进行的模型调用过多（上限 ${LLM_MAX_CONCURRENT} 个），请等待当前任务完成后再试。`
    );
  }
  const lease = acquireLlmLease({ maxConcurrent: LLM_MAX_CONCURRENT, leaseMs: LLM_LEASE_MS });
  if (!lease) {
    throw new LlmBusyError(
      `同时进行的模型调用过多（上限 ${LLM_MAX_CONCURRENT} 个），请等待当前任务完成后再试。`
    );
  }
  llmInFlight += 1;
  const deadline = new AbortController();
  const signal = opts?.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  const timeoutMs = opts?.connectionTest ? 15_000 : LLM_CALL_TIMEOUT_MS;
  const deadlineTimer = setTimeout(() => {
    deadline.abort(new LlmTimeoutError(`LLM 调用超时（${timeoutMs / 1000} 秒未完成），请重试`));
  }, timeoutMs);
  try {
    return await runChatStream(task, messages, onDelta, opts, signal);
  } finally {
    clearTimeout(deadlineTimer);
    // 放在 finally 里：超时、取消、上游报错都走这条路，
    // 漏掉任何一条都会让名额永久泄漏，几次之后全站再也发不出模型请求。
    llmInFlight -= 1;
    try {
      releaseLlmLease(lease);
    } catch {
      logServerEvent("warn", "llm.lease.release", { context: { resource: "llm-budget" } });
    }
  }
}

async function runChatStream(
  task: LlmTask,
  messages: ChatMessage[],
  onDelta?: (delta: string) => void,
  opts?: ChatStreamOptions,
  signal?: AbortSignal
): Promise<string> {
  checkModelInput(messages);
  const resolved = opts?.connectionTest ?? resolveModel(task);
  const { baseUrl, apiKey, model, format, proxy } = resolved;
  const configuredMaxTokens = "maxOutputTokens" in resolved && typeof resolved.maxOutputTokens === "number"
    ? resolved.maxOutputTokens
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const maxTokens: number = opts?.connectionTest ? 1024 : (opts?.maxTokens ?? configuredMaxTokens);
  const url = buildChatUrl(baseUrl, format);
  const startedAt = Date.now();
  const source = opts?.source;
  let usageNotified = false;
  const meter = (status: "ok" | "failed" | "cancelled", errorCode: string, attempts: number, usage: LlmUsage) => {
    if (!usageNotified) {
      usageNotified = true;
      try { void Promise.resolve(opts?.onUsage?.({ ...usage })).catch(() => {}); } catch {}
    }
    if (!source) return;
    recordLlmCall({ source, task, model, apiFormat: format, status, errorCode, attempts, durationMs: Date.now() - startedAt, usage });
  };
  const logLlm: LogFn = ({ status, errorCode, attempt }) =>
    // 与全站其他日志一样走 logServerEvent：字段受白名单约束、格式统一，并带上 requestId。
    // [server-error] 那条，却搜不到 LLM 层的重试细节，只能靠时间戳在噪声里盲猜。
    logServerEvent("info", "llm.request", {
      requestId: opts?.requestId,
      durationMs: Date.now() - startedAt,
      context: {
        task,
        format,
        status,
        ...(attempt ? { attempt } : {}),
        ...(errorCode ? { errorCode } : {}),
        resource: "llm",
      },
    });

  let useStream = !opts?.connectionTest;
  let attempt = 0;
  let tokenSent = false;
  let knownUsage: LlmUsage = EMPTY_USAGE;

  const addUsage = (previous: LlmUsage, current: LlmUsage): LlmUsage => ({
    inputTokens: previous.inputTokens === null ? current.inputTokens : current.inputTokens === null ? previous.inputTokens : previous.inputTokens + current.inputTokens,
    outputTokens: previous.outputTokens === null ? current.outputTokens : current.outputTokens === null ? previous.outputTokens : previous.outputTokens + current.outputTokens,
    cachedTokens: previous.cachedTokens === null ? current.cachedTokens : current.cachedTokens === null ? previous.cachedTokens : previous.cachedTokens + current.cachedTokens,
  });

  const wrappedOnDelta = onDelta
    ? (delta: string) => {
        tokenSent = true;
        onDelta(delta);
      }
    : undefined;

  let requestIndex = 0;
  for (;;) {
    let attemptUsage: LlmUsage = EMPTY_USAGE;
    try {
      signal?.throwIfAborted();
      const { content, usage } = await requestOnce({
        format,
        model,
        url,
        apiKey,
        proxy,
        messages,
        maxTokens,
        useStream,
        attempt,
        requestIndex: requestIndex++,
        logLlm,
        // JSON 输出在解析成功前不能发给客户端，否则坏响应会泄漏且不能安全重试。
        onDelta: opts?.requireJson ? undefined : wrappedOnDelta,
        onUsage: (reported) => { attemptUsage = reported; },
        onHttpStatus: opts?.onHttpStatus,
        onRequestProgress: opts?.onRequestProgress,
        signal,
      });
      signal?.throwIfAborted();
      if (opts?.requireJson) {
        try {
          if (opts.requireJson === "strict") parseModelJson(content);
          else extractJson(content);
        } catch { throw new LlmInvalidJsonError(); }
      }
      if (opts?.requireJson) wrappedOnDelta?.(content);
      meter("ok", "", attempt, addUsage(knownUsage, usage));
      return content;
    } catch (err) {
      knownUsage = addUsage(knownUsage, attemptUsage);
      // 与计量使用同一份已观测总量；不为获取拒绝终态后的 usage 继续读取流。
      if (err instanceof LlmResponseError) err.usage = { ...knownUsage };
      const errorCode = err instanceof LlmHttpError ? `http_${err.status}`
        : err instanceof LlmResponseError ? err.code
        : err instanceof LlmTimeoutError ? "timeout"
        : err instanceof LlmInvalidJsonError ? "invalid_json"
        : err instanceof TypeError ? "network"
        : "unknown";
      // 若已由客户端主动取消，直接向上抛出
      if (opts?.signal?.aborted) {
        meter("cancelled", "cancelled", attempt, knownUsage);
        throw err;
      }

      // 个别网关不支持 stream 参数，未输出 token 且收到 400 后降级为非流式再试
      if (err instanceof LlmHttpError && err.status === 400 && useStream && !tokenSent) {
        useStream = false;
        logLlm({ status: "fallback", errorCode: "stream_unsupported", attempt });
        continue;
      }
      // 缺少完成事件可在未向客户端发送内容时重试；其他协议错误重试不会改变结果。
      const retryable =
        !tokenSent && !signal?.aborted && (
          err instanceof LlmTimeoutError || err instanceof TypeError ||
          err instanceof LlmInvalidJsonError ||
          (err instanceof LlmResponseError && err.reason === "interrupted") ||
          (err instanceof LlmHttpError && RETRYABLE_STATUS.has(err.status))
        );
      if (!retryable || attempt >= (opts?.connectionTest ? 0 : LLM_MAX_RETRIES)) {
        logLlm({ status: "error", errorCode, attempt });
        meter("failed", errorCode, attempt, knownUsage);
        throw err;
      }
      attempt += 1;
      logLlm({ status: "retry", errorCode, attempt });
      try {
        await sleep(Math.max(1000 * 2 ** (attempt - 1), err instanceof LlmHttpError ? err.retryAfterMs : 0), signal);
      } catch (sleepError) {
        meter(opts?.signal?.aborted ? "cancelled" : "failed", opts?.signal?.aborted ? "cancelled" : sleepError instanceof LlmTimeoutError ? "timeout" : errorCode, attempt, knownUsage);
        throw sleepError;
      }
    }
  }
}

/** 找到一个对象/数组的完整边界；字符串中的括号与围栏只是正文。语法仍交给原生解析器。 */
function jsonContainerEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '"') {
      for (index++; index < text.length; index++) {
        if (text[index] === "\\") index++;
        else if (text[index] === '"') break;
      }
    } else if (text[index] === "{" || text[index] === "[") depth++;
    else if ((text[index] === "}" || text[index] === "]") && --depth === 0) return index;
  }
  return -1;
}

/** 从 LLM 回复中提取 JSON（容忍 ```json 围栏与前后杂文） */
export function extractJson<T>(raw: string): T {
  let text = raw.trim();
  // 合法 JSON 的字符串也可能含代码围栏；先解析整体，不能把字段正文当成回复容器。
  try { return parseModelJson(text) as T; }
  catch (error) {
    // 结构完整但字段冲突时不能再抽取正文里的围栏，丢弃冲突后冒充成功。
    if (error instanceof DuplicateModelJsonKeyError) throw new LlmInvalidJsonError();
  }
  const outerFence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (outerFence) {
    try { return parseModelJson((outerFence[1] ?? "").trim()) as T; }
    catch (error) {
      if (error instanceof DuplicateModelJsonKeyError) throw new LlmInvalidJsonError();
    }
  }
  // 有前后说明时，优先检查最早的完整对象/数组，不能把其字符串内的围栏当成外层回复。
  // 真正的外层围栏也先按 JSON 结构找结束位置，避免被正文中的三反引号提前截断。
  const openingFence = /```(?:json)?\s*/.exec(text);
  if (openingFence) {
    const containerStarts = /[\[{]/g;
    for (let match = containerStarts.exec(text); match && match.index < openingFence.index; match = containerStarts.exec(text)) {
      const end = jsonContainerEnd(text, match.index);
      if (end === -1) break;
      try {
        const candidate = parseModelJson(text.slice(match.index, end + 1)) as T;
        if (end > openingFence.index) return candidate;
        // 说明中的独立 {} / [] 不抢占真正围栏；仍检查后续对象，不能跳过其字段冲突。
      }
      catch (error) {
        if (error instanceof DuplicateModelJsonKeyError || openingFence.index < end) {
          throw new LlmInvalidJsonError();
        }
      }
      containerStarts.lastIndex = end + 1;
    }
    const bodyStart = openingFence.index + openingFence[0].length;
    if (text[bodyStart] === "{" || text[bodyStart] === "[") {
      const end = jsonContainerEnd(text, bodyStart);
      if (end !== -1) {
        try { return parseModelJson(text.slice(bodyStart, end + 1)) as T; }
        catch { throw new LlmInvalidJsonError(); }
      }
    }
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = (fence[1] ?? "").trim();
  try {
    return parseModelJson(text) as T;
  } catch (error) {
    if (error instanceof DuplicateModelJsonKeyError) throw new LlmInvalidJsonError();
    const firstObj = text.indexOf("{");
    const firstArr = text.indexOf("[");
    const start =
      firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    const lastObj = text.lastIndexOf("}");
    const lastArr = text.lastIndexOf("]");
    const end = Math.max(lastObj, lastArr);
    if (start !== -1 && end > start) {
      try {
        return parseModelJson(text.slice(start, end + 1)) as T;
      } catch { /* 原生 SyntaxError 可能含正文，统一使用无正文的错误。 */ }
    }
    throw new LlmInvalidJsonError();
  }
}
