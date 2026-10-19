import type { ApiFormat } from "./settings-constants";
import { EMPTY_USAGE, mergeUsage, type LlmUsage } from "./llm-source";

export type TextContentPart = { type: "text"; text: string };
export type ImageContentPart = {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
};
export type MessageContentPart = TextContentPart | ImageContentPart;
export type MessageContent = string | MessageContentPart[];

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: MessageContent;
};

// 调用方既可从这里、也可从 ./llm-source 拿到这几个符号
export { EMPTY_USAGE, mergeUsage };
export type { LlmUsage };

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class LlmResponseError extends Error {
  constructor(message: string, readonly code: "provider" | "incomplete" | "protocol") {
    super(message);
    this.name = "LlmResponseError";
  }
}

/**
 * 展开网络错误的 cause 链，生成可读描述。
 * Node 的 fetch 在 DNS / TCP / TLS 层失败时只抛出 `TypeError: fetch failed`，
 * 真正原因（ENOTFOUND、ECONNREFUSED、CERT_HAS_EXPIRED 等）藏在 error.cause 里。
 */
export function describeNetworkError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const detail = `${current.message}${current.name === "Error" ? "" : `（${current.name}）`}`;
      if (detail && !parts.includes(detail)) parts.push(detail);
      current = current.cause;
    } else {
      const text = String(current);
      if (text && !parts.includes(text)) parts.push(text);
      break;
    }
  }
  return parts.join(" ← ") || "未知错误";
}

/**
 * 规范化 Base URL：
 * 剥离末尾多余斜杠，并防御性剥离用户误填或历史残留的已知 endpoint 后缀
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let clean = baseUrl.trim().replace(/\/+$/, "");
  clean = clean.replace(/\/(chat\/completions|messages|responses)$/, "");
  return clean.replace(/\/+$/, "");
}

/**
 * 根据协议格式智能拼接补全请求 URL
 */
export function buildChatUrl(baseUrl: string, format: ApiFormat): string {
  const clean = normalizeBaseUrl(baseUrl);
  switch (format) {
    case "anthropic_messages":
      return `${clean}/messages`;
    case "openai_responses":
      return `${clean}/responses`;
    case "openai_chat":
    default:
      return `${clean}/chat/completions`;
  }
}

/**
 * 拼接模型列表查询 URL
 */
export function buildModelsUrl(baseUrl: string): string {
  const clean = normalizeBaseUrl(baseUrl);
  return `${clean}/models`;
}

/**
 * 根据协议构造请求 Headers。
 * Anthropic 官方协议只用 x-api-key，不额外附带 Authorization，
 * 避免同一把 Key 出现在两个请求头里（请求日志/代理日志会各记一份，轮换时无谓扩大范围）。
 * 若第三方「Anthropic 兼容」网关只认 Bearer，请改用 openai_chat 格式接入。
 */
export function buildHeaders(format: ApiFormat, apiKey: string): Record<string, string> {
  const trimmedKey = apiKey.trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (format === "anthropic_messages") {
    headers["x-api-key"] = trimmedKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${trimmedKey}`;
  }

  return headers;
}

function formatAnthropicContent(content: MessageContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image_url") {
      const url = part.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: match[1] || "image/png",
            data: match[2] || "",
          },
        };
      }
      return { type: "image", source: { type: "url", url } };
    }
    return part;
  });
}

function formatOpenAiResponsesContent(content: MessageContent): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text };
    }
    if (part.type === "image_url") {
      return { type: "input_image", image_url: part.image_url.url };
    }
    return part;
  });
}

function stringifySystemContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextContentPart => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}

/**
 * 根据协议构造请求 Body
 */
export function buildRequestBody(args: {
  format: ApiFormat;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  stream: boolean;
}): Record<string, unknown> {
  const { format, model, messages, maxTokens, stream } = args;

  if (format === "anthropic_messages") {
    // 1. Anthropic 要求 system prompt 在外层字段，不能在 messages 中
    const systemParts = messages
      .filter((m) => m.role === "system")
      .map((m) => stringifySystemContent(m.content).trim())
      .filter(Boolean);
    const system = systemParts.join("\n\n");

    const nonSystem = messages.filter((m) => m.role === "user" || m.role === "assistant");
    const formatted: { role: "user" | "assistant"; content: unknown }[] = [];
    for (const m of nonSystem) {
      formatted.push({ role: m.role as "user" | "assistant", content: formatAnthropicContent(m.content) });
    }
    // Anthropic 要求 messages 至少包含一条消息
    if (formatted.length === 0) {
      formatted.push({ role: "user", content: " " });
    }

    return {
      model,
      ...(system ? { system } : {}),
      messages: formatted,
      // Messages 协议要求 max_tokens 必填，其他协议仍可省略输出额度。
      max_tokens: maxTokens ?? 4096,
      ...(stream ? { stream: true } : {}),
    };
  }

  if (format === "openai_responses") {
    return {
      model,
      input: messages.map((m) => ({ role: m.role, content: formatOpenAiResponsesContent(m.content) })),
      ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  // 默认 openai_chat。stream_options 让流式响应也带 usage；
  // 网关不支持会返回 400，由 llm.ts 现有的「降级非流式」逻辑接管。
  return {
    model,
    messages,
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

function rejectFailedResponse(response: Record<string, unknown>, eventType?: unknown): void {
  const failed = eventType === "response.failed" || response.status === "failed";
  const incomplete = eventType === "response.incomplete" || response.status === "incomplete";
  if (!failed && !incomplete) return;
  const details = response.incomplete_details as { reason?: unknown } | null | undefined;
  const outputLimit = typeof details?.reason === "string" && details.reason.startsWith("max_output_tokens");
  throw new LlmResponseError(
    failed
      ? "LLM 响应失败"
      : outputLimit
        ? "LLM 响应未完成：已达到输出上限，可前往「设置」调大最大输出 token 限制后重试"
        : "LLM 响应未完成",
    incomplete ? "incomplete" : "provider"
  );
}

function rejectOutputLimit(reason: unknown): void {
  if (reason === "length" || reason === "max_tokens") {
    throw new LlmResponseError("LLM 响应未完成：已达到输出上限，可前往「设置」调大最大输出 token 限制后重试", "incomplete");
  }
}

function readTextParts(content: unknown, types: readonly string[]): string {
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && types.includes(part.type) && typeof part.text === "string")
    .map((part) => part.text).join("");
}

function requireReply(content: string): string {
  if (!content.trim()) throw new LlmResponseError("LLM 返回了空正文", "protocol");
  return content;
}

function readChatReply(json: Record<string, unknown>): string {
  const choices = json.choices as Array<{ finish_reason?: unknown; message?: { content?: unknown }; text?: unknown }> | undefined;
  const choice = choices?.[0];
  rejectOutputLimit(choice?.finish_reason);
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : readTextParts(content, ["text"]);
  return requireReply(text.trim() ? text : typeof choice?.text === "string" ? choice.text : "");
}

/** 解析非流式 JSON 响应；失败或未完成响应中的部分文本不能视为成功。 */
export function parseNonStreamReply(format: ApiFormat, json: Record<string, unknown>): string {
  if (json.error) {
    throw new LlmResponseError("LLM 返回错误", "provider");
  }

  if (format === "anthropic_messages") {
    rejectOutputLimit(json.stop_reason);
    return requireReply(readTextParts(json.content, ["text"]));
  }

  if (format === "openai_responses") {
    rejectFailedResponse(json);
    if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text;
    if (Array.isArray(json.output)) {
      const parts: string[] = [];
      for (const item of json.output) {
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          if (rec.type !== undefined && !["message", "output_text", "text"].includes(String(rec.type))) continue;
          if (Array.isArray(rec.content)) {
            parts.push(readTextParts(rec.content, ["output_text", "text"]));
          } else if (typeof rec.text === "string") {
            parts.push(rec.text);
          }
        }
      }
      if (parts.join("").trim()) return parts.join("");
    }
    // 兼容部分代理仍返回 choices 结构
    return readChatReply(json);
  }

  // openai_chat
  return readChatReply(json);
}

/**
 * Anthropic 的 input_tokens 不含缓存读写，OpenAI 的 prompt_tokens 已含缓存命中。
 * 这里统一成「输入总量含缓存」，保证 cached ≤ input，跨协议命中率才有统一含义。
 */
function readAnthropicUsage(raw: Record<string, unknown>): Partial<LlmUsage> {
  const prompt = finiteOrNull(raw.input_tokens);
  const cacheRead = finiteOrNull(raw.cache_read_input_tokens);
  const cacheWrite = finiteOrNull(raw.cache_creation_input_tokens);
  const output = finiteOrNull(raw.output_tokens);
  const partial: Partial<LlmUsage> = {};
  if (prompt !== null || cacheRead !== null || cacheWrite !== null) {
    partial.inputTokens = (prompt ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  if (output !== null) partial.outputTokens = output;
  if (cacheRead !== null) partial.cachedTokens = cacheRead;
  return partial;
}

function readOpenAiChatUsage(raw: Record<string, unknown>): Partial<LlmUsage> {
  const prompt = finiteOrNull(raw.prompt_tokens);
  const completion = finiteOrNull(raw.completion_tokens);
  const details = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = details ? finiteOrNull(details.cached_tokens) : null;
  const partial: Partial<LlmUsage> = {};
  if (prompt !== null) partial.inputTokens = prompt;
  if (completion !== null) partial.outputTokens = completion;
  if (cached !== null) partial.cachedTokens = cached;
  return partial;
}

function readOpenAiResponsesUsage(raw: Record<string, unknown>): Partial<LlmUsage> {
  const input = finiteOrNull(raw.input_tokens);
  const output = finiteOrNull(raw.output_tokens);
  const details = raw.input_tokens_details as Record<string, unknown> | undefined;
  const cached = details ? finiteOrNull(details.cached_tokens) : null;
  const partial: Partial<LlmUsage> = {};
  if (input !== null) partial.inputTokens = input;
  if (output !== null) partial.outputTokens = output;
  if (cached !== null) partial.cachedTokens = cached;
  return partial;
}

function readUsage(format: ApiFormat, raw: unknown): Partial<LlmUsage> {
  if (!raw || typeof raw !== "object") return {};
  const usage = raw as Record<string, unknown>;
  if (format === "anthropic_messages") return readAnthropicUsage(usage);
  if (format === "openai_responses") return readOpenAiResponsesUsage(usage);
  return readOpenAiChatUsage(usage);
}

/** 非流式响应里的 usage；缺字段一律记 null，绝不折叠成 0。 */
export function parseNonStreamUsage(format: ApiFormat, json: Record<string, unknown>): LlmUsage {
  const raw = format === "openai_responses" && json.usage === undefined
    ? (json.response as Record<string, unknown> | undefined)?.usage
    : json.usage;
  return mergeUsage(EMPTY_USAGE, readUsage(format, raw));
}

/**
 * 解析单行 SSE payload 并提取增量内容
 */
export function handleSsePayload(
  format: ApiFormat,
  payload: string,
  onDelta: (text: string) => void,
  onUsage?: (usage: Partial<LlmUsage>) => void,
): "done" | undefined {
  if (!payload.trim()) return; // 空 data 心跳不携带协议数据
  if (payload === "[DONE]") return "done";

  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new LlmResponseError("LLM SSE 数据不是有效 JSON", "protocol");
  }

  // 统一错误捕获
  if (chunk.type === "error" || chunk.error) {
    throw new LlmResponseError("LLM 流式返回错误", "provider");
  }

  if (format === "anthropic_messages") {
    if (chunk.type === "message_start") {
      const message = chunk.message as Record<string, unknown> | undefined;
      onUsage?.(readUsage(format, message?.usage));
      return;
    }
    if (chunk.type === "message_delta") {
      onUsage?.(readUsage(format, chunk.usage));
      const stopReason = (chunk.delta as { stop_reason?: unknown } | undefined)?.stop_reason
        ?? (chunk as { stop_reason?: unknown }).stop_reason;
      rejectOutputLimit(stopReason);
      if (stopReason === "end_turn" || stopReason === "stop" || stopReason === "stop_sequence") {
        return "done";
      }
      return;
    }
    if (chunk.type === "message_stop") return "done";
    if (chunk.type === "content_block_start") {
      const block = chunk.content_block as { type?: string; text?: unknown } | undefined;
      if (block?.type === "text" && typeof block.text === "string") onDelta(block.text);
    }
    if (chunk.type === "content_block_delta") {
      const delta = chunk.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        onDelta(delta.text);
      }
    }
    return;
  }

  if (format === "openai_responses") {
    const response = chunk.response && typeof chunk.response === "object"
      ? chunk.response as Record<string, unknown>
      : chunk;
    rejectFailedResponse(response, chunk.type);
    if (chunk.type === "response.done" || chunk.type === "response.completed") {
      onUsage?.(readUsage(format, response.usage));
      return "done";
    }
    if (chunk.type !== undefined && chunk.type !== "response.output_text.delta" && !chunk.choices) return;
    if (typeof chunk.delta === "string") {
      onDelta(chunk.delta);
      return;
    }
    if (chunk.type === "response.output_text.delta" && typeof chunk.text === "string") {
      onDelta(chunk.text);
      return;
    }
    const deltaObj = chunk.delta as { text?: unknown } | undefined;
    if (typeof deltaObj?.text === "string") {
      onDelta(deltaObj.text);
      return;
    }
    // 兼容部分代理使用 choices
    const choices = chunk.choices as Array<{ finish_reason?: unknown; delta?: { content?: string } }> | undefined;
    rejectOutputLimit(choices?.[0]?.finish_reason);
    if (typeof choices?.[0]?.delta?.content === "string") {
      onDelta(choices[0].delta.content);
    }
    return;
  }

  // 默认 openai_chat
  // 末块 usage 的 choices 为空数组，先读 usage 再取增量
  if (chunk.usage !== undefined) onUsage?.(readUsage(format, chunk.usage));
  const choices = chunk.choices as Array<{ finish_reason?: unknown; delta?: { content?: string } }> | undefined;
  rejectOutputLimit(choices?.[0]?.finish_reason);
  if (typeof choices?.[0]?.delta?.content === "string") {
    onDelta(choices[0].delta.content);
  }
}
