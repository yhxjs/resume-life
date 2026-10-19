import { readSettings, type ApiFormat } from "./settings";
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens } from "./settings-constants";
import { checkModelInput } from "./llm-input-budget";
import type { LlmSource } from "./llm-source";
import { recordLlmCall } from "./llm-call-log";
import { logServerEvent } from "./server-errors";
import { parseHttpBaseUrl, type readModelSettingsRequest } from "./settings-request";
import { proxyConfigFromSettings, type ProxyConfig } from "./proxy-config";
import { proxyFetchInit } from "./proxy-dispatcher";
import { EMPTY_USAGE, mergeUsage, parseNonStreamUsage, type LlmUsage } from "./llm-adapter";
import { acquireLlmLease, releaseLlmLease } from "./shared-budgets";
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
export const LLM_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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

/** requireJson 校验失败：回复不是可解析的 JSON。未向客户端输出过内容时可重试 */
class LlmInvalidJsonError extends Error {
  constructor(raw: string) {
    super(`AI 返回的内容不是有效 JSON：${raw.slice(0, 200)}`);
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
  logLlm: LogFn;
  onDelta?: (delta: string) => void;
  onUsage?: (usage: LlmUsage) => void;
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

  const onClientAbort = () => {
    abortKind = "client";
    controller.abort(signal?.reason);
  };
  signal?.addEventListener("abort", onClientAbort);

  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortKind = "idle";
      controller.abort();
    }, LLM_IDLE_TIMEOUT_MS);
  };
  const totalTimer = setTimeout(() => {
    abortKind = "total";
    controller.abort();
  }, LLM_TOTAL_TIMEOUT_MS);
  bumpIdle();

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
    logLlm({ status: String(res.status), attempt });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new LlmHttpError(res.status, res.headers.get("Retry-After"));
    }
    const content = (
      useStream
        ? await readSseContent(res, format, bumpIdle, onDelta, collectUsage)
        : await readJsonContent(res, format, collectUsage)
    ).trim();
    signal?.throwIfAborted();
    if (!content) throw new LlmResponseError("LLM 返回了空内容", "protocol");
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
  }
}

async function readJsonContent(
  res: Response,
  format: ApiFormat,
  onUsage: (usage: Partial<LlmUsage>) => void,
): Promise<string> {
  if (!res.body) throw new LlmResponseError("LLM 响应缺少响应体", "protocol");
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LLM_MAX_RESPONSE_BYTES) {
        throw new LlmResponseError("LLM 响应超过字节上限", "protocol");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as Record<string, unknown>;
  onUsage(parseNonStreamUsage(format, data));
  return parseNonStreamReply(format, data);
}

/** 解析 SSE 流，聚合文本内容并支持向外实时逐块输出 */
async function readSseContent(
  res: Response,
  format: ApiFormat,
  bumpIdle: () => void,
  onDelta?: (delta: string) => void,
  onUsage?: (usage: Partial<LlmUsage>) => void
): Promise<string> {
  if (!res.body) throw new Error("LLM 流式响应缺少响应体");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let responseBytes = 0;
  let contentBytes = 0;

  const handleLine = (rawLine: string): "done" | undefined => {
    if (Buffer.byteLength(rawLine, "utf8") > LLM_MAX_SSE_FRAME_BYTES) {
      throw new LlmResponseError("LLM SSE 单帧超过字节上限", "protocol");
    }
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) return; // 空行、注释及非 data 字段
    const payload = line.slice(5).trim();
    return handleSsePayload(format, payload, (deltaText) => {
      contentBytes += Buffer.byteLength(deltaText, "utf8");
      if (contentBytes > LLM_MAX_RESPONSE_BYTES) {
        throw new LlmResponseError("LLM 响应内容超过字节上限", "protocol");
      }
      content += deltaText;
      onDelta?.(deltaText);
    }, onUsage);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      bumpIdle();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > LLM_MAX_RESPONSE_BYTES) {
        throw new LlmResponseError("LLM 响应超过字节上限", "protocol");
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (handleLine(line) === "done") return content;
      }
      if (Buffer.byteLength(buffer, "utf8") > LLM_MAX_SSE_FRAME_BYTES) {
        throw new LlmResponseError("LLM SSE 单帧超过字节上限", "protocol");
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      if (handleLine(buffer) === "done") return content;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new LlmResponseError("LLM 流式响应意外中断，未收到完成事件", "protocol");
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
  /** 关联 ID，随请求从路由层透传下来，用于把 LLM 层日志与用户看到的报错串起来 */
  requestId?: string;
  /** 未保存配置的连接测试：固定非流式、1024 输出 token、15 秒截止且不自动重试。 */
  connectionTest?: ReturnType<typeof readModelSettingsRequest>;
  /**
   * 要求回复是可解析的 JSON（与 extractJson 同一套容错：容忍围栏与前后杂文）。
   * 不满足时按可重试错误自动重新生成，总尝试次数与网络重试共享上限；
   * 流式回调已向客户端输出过内容后无法重试，只能原样返回由调用方解析报错。
   */
  requireJson?: boolean;
};

/**
 * 流式调用 LLM 接口：
 * 实时通过 onDelta 回调逐字/逐块输出文本，并在结束时返回完整的聚合文本。
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
  const meter = (status: "ok" | "failed" | "cancelled", errorCode: string, attempts: number, usage: LlmUsage) => {
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
        logLlm,
        onDelta: wrappedOnDelta,
        onUsage: (reported) => { attemptUsage = reported; },
        signal,
      });
      if (opts?.requireJson) {
        try { extractJson(content); } catch { throw new LlmInvalidJsonError(content); }
      }
      meter("ok", "", attempt, addUsage(knownUsage, usage));
      return content;
    } catch (err) {
      knownUsage = addUsage(knownUsage, attemptUsage);
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
      // 仅网络、超时、限流、服务故障和 JSON 校验失败可重试；协议错误重复调用不会改变结果。
      const retryable =
        !tokenSent && !signal?.aborted && (
          err instanceof LlmTimeoutError || err instanceof TypeError ||
          err instanceof LlmInvalidJsonError ||
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

/** 从 LLM 回复中提取 JSON（容忍 ```json 围栏与前后杂文） */
export function extractJson<T>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = (fence[1] ?? "").trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    const firstObj = text.indexOf("{");
    const firstArr = text.indexOf("[");
    const start =
      firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    const lastObj = text.lastIndexOf("}");
    const lastArr = text.lastIndexOf("]");
    const end = Math.max(lastObj, lastArr);
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as T;
    }
    throw new Error(`AI 返回的内容不是有效 JSON：${raw.slice(0, 200)}`);
  }
}
