import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFormat } from "../settings-constants";
import { handleSsePayload, LlmResponseError, parseNonStreamReply, parseNonStreamUsage } from "../llm-adapter";

const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../llm-call-log", () => ({ recordLlmCall: (entry: Record<string, unknown>) => recorded.calls.push(entry) }));

const text = '{"result":"partial but valid JSON"}';
const event = (payload: unknown) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
const limited = [
  {
    format: "openai_chat" as const,
    json: { choices: [{ message: { content: text }, finish_reason: "length" }], usage: { prompt_tokens: 12, completion_tokens: 5 } },
    stream: event({ choices: [{ delta: { content: text } }] }) + event({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 12, completion_tokens: 5 } }) + event("[DONE]"),
  },
  {
    format: "anthropic_messages" as const,
    json: { content: [{ type: "text", text }], stop_reason: "max_tokens", usage: { input_tokens: 12, output_tokens: 5 } },
    stream: event({ type: "message_start", message: { usage: { input_tokens: 12 } } }) + event({ type: "content_block_delta", delta: { type: "text_delta", text } }) + event({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } }) + event({ type: "message_stop" }),
  },
  {
    format: "openai_responses" as const,
    json: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: text, usage: { input_tokens: 12, output_tokens: 5 } },
    stream: event({ type: "response.output_text.delta", delta: text }) + event({ type: "response.incomplete", response: {
      status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 12, output_tokens: 5 },
    } }) + event("[DONE]"),
  },
];

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-llm-contract-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", root);
  vi.resetModules();
  recorded.calls.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("resume-life-llm-contract-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each(limited)("$format 输出截断", ({ format, json, stream }) => {
  it("非流式合法 JSON 仍明确报 incomplete", () => {
    expect(() => parseNonStreamReply(format, json)).toThrow(LlmResponseError);
    try { parseNonStreamReply(format, json); } catch (error) { expect(error).toMatchObject({ code: "incomplete", reason: "output_limit", usage: null }); }
  });

  it.each([false, true])("流式=%s：后续完成事件不能把截断转为成功，并记录失败用量", async (useStream) => {
    settings.api_format = format;
    const upstream = vi.fn(async () => new Response(stream));
    if (!useStream) upstream.mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(Response.json(json));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    await expect(chatStream("parse", [], () => {}, { source: { feature: "简历导入解析" }, requireJson: true })).rejects.toMatchObject({
      name: "LlmResponseError", code: "incomplete", reason: "output_limit", usage: { inputTokens: 12, outputTokens: 5, cachedTokens: null },
    });
    expect(upstream).toHaveBeenCalledTimes(useStream ? 1 : 2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "incomplete", usage: { inputTokens: 12, outputTokens: 5 } });
  });
});

describe.each((["openai_chat", "openai_responses"] as const).flatMap(format =>
  (["content_filter", "tool_calls", "function_call"] as const).map(reason => ({ format, reason }))))("$format 的非正文终态 $reason", ({ format, reason }) => {
  const code = reason === "content_filter" ? "incomplete" : "protocol";
  const hint = reason === "content_filter" ? "过滤" : "工具调用";
  const usage = { prompt_tokens: 12, completion_tokens: 5 };
  const json = { choices: [{ message: { content: text }, finish_reason: reason }], usage };

  it("即使正文是合法 JSON，也不能作为完整非流式回复", () => {
    const failure = (() => { try { return parseNonStreamReply(format, json); } catch (error) { return error; } })();
    expect(failure).toBeInstanceOf(LlmResponseError);
    expect(failure).toMatchObject({ code, reason: reason === "content_filter" ? "content_filter" : "tool_call", message: expect.stringContaining(hint) });
  });

  it.each([false, true])("流式=%s：不返回已缓存 JSON、不自动重试，保留失败记录", async useStream => {
    settings.api_format = format;
    const stream = event({ choices: [{ delta: { content: text } }] }) +
      event({ choices: [{ delta: {}, finish_reason: reason }], usage }) + event("[DONE]");
    const upstream = vi.fn(async () => new Response(stream));
    if (!useStream) upstream.mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(Response.json(json));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    const onDelta = vi.fn();
    await expect(chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" }))
      .rejects.toMatchObject({ name: "LlmResponseError", code, message: expect.stringContaining(hint) });
    expect(onDelta).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(useStream ? 1 : 2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: code, attempts: 0 });
    if (format === "openai_chat") expect(recorded.calls[0]).toMatchObject({ usage: { inputTokens: 12, outputTokens: 5 } });
  });
});

describe.each([
  { reason: "tool_use", code: "protocol", diagnosis: "tool_call", hint: "工具调用" },
  { reason: "pause_turn", code: "incomplete", diagnosis: "paused", hint: "暂停" },
  { reason: "refusal", code: "incomplete", diagnosis: "refusal", hint: "拒绝" },
  { reason: "model_context_window_exceeded", code: "incomplete", diagnosis: "context_limit", hint: "上下文" },
])("Anthropic 非正文终态 $reason", ({ reason, code, diagnosis, hint }) => {
  const json = { content: [{ type: "text", text }], stop_reason: reason, stop_details: { detail: "SYNTHETIC_PRIVATE_MARKER" },
    usage: { input_tokens: 12, output_tokens: 5 } };
  it("非流式即使已有合法 JSON 也不作为完整正文", () => {
    expect(() => parseNonStreamReply("anthropic_messages", json))
      .toThrow(expect.objectContaining({ code, message: expect.stringContaining(hint) }));
  });

  it.each(["stream", "root-stop-reason", "fallback"])("%s：后续 message_stop 不能掩盖失败，不自动重试且保留用量", async mode => {
    settings.api_format = "anthropic_messages";
    const stream = event({ type: "message_start", message: { usage: { input_tokens: 12 } } }) +
      event({ type: "content_block_delta", delta: { type: "text_delta", text } }) +
      event({ type: "message_delta", ...(mode === "root-stop-reason" ? { stop_reason: reason } : { delta: { stop_reason: reason } }),
        usage: { output_tokens: 5 }, stop_details: json.stop_details }) + event({ type: "message_stop" });
    const upstream = vi.fn(async () => new Response(stream));
    if (mode === "fallback") upstream.mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(Response.json(json));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    const onDelta = vi.fn();
    const failure = await chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" })
      .then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ name: "LlmResponseError", code, reason: diagnosis, message: expect.stringContaining(hint),
      usage: { inputTokens: 12, outputTokens: 5, cachedTokens: null } });
    expect((failure as Error).message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(onDelta).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(mode === "fallback" ? 2 : 1);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: code, attempts: 0,
      usage: { inputTokens: 12, outputTokens: 5 } });
    expect(JSON.stringify(recorded.calls)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  });
});

it.each(["end_turn", "stop_sequence", "stop"])("Anthropic 正常 %s 保留完整正文与无需等待连接关闭的完成行为", async reason => {
  expect(parseNonStreamReply("anthropic_messages", { content: [{ type: "text", text }], stop_reason: reason })).toBe(text);
  settings.api_format = "anthropic_messages";
  const cancel = vi.fn();
  const upstream = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        event({ type: "message_start", message: { usage: { input_tokens: 12 }, stop_reason: null } }) +
        event({ type: "content_block_delta", delta: { type: "text_delta", text } }) +
        event({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 5 } })));
    },
    cancel,
  })));
  vi.stubGlobal("fetch", upstream);
  const { chatStream } = await import("../llm");
  const onDelta = vi.fn();
  expect(await chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" })).toBe(text);
  expect(onDelta.mock.calls).toEqual([[text]]);
  expect(cancel).toHaveBeenCalledOnce();
  expect(upstream).toHaveBeenCalledOnce();
  expect(recorded.calls[0]).toMatchObject({ status: "ok", usage: { inputTokens: 12, outputTokens: 5 } });
});

describe.each(["openai_chat", "anthropic_messages", "openai_responses"] as const)("%s 的提供方 JSON 边界", format => {
  it.each(["null", "[]", "true", "3", '"SYNTHETIC_PRIVATE_MARKER"'])("直接解析回复和用量均拒绝非对象 %s", wire => {
    for (const parse of [parseNonStreamReply, parseNonStreamUsage]) {
      const failure = (() => { try { return parse(format, JSON.parse(wire)); } catch (error) { return error; } })();
      expect(failure).toBeInstanceOf(LlmResponseError);
      expect(failure).toMatchObject({ code: "protocol" });
    }
  });

  it.each(["null", "[]", "true", "3", '"SYNTHETIC_PRIVATE_MARKER"', '{"SYNTHETIC_PRIVATE_MARKER":bad-json', ""])("降级响应 %j 明确归为协议失败，不泄露响应或重试", async wire => {
    settings.api_format = format;
    vi.useFakeTimers();
    try {
      const upstream = vi.fn(async () => new Response(wire))
        .mockResolvedValueOnce(new Response(null, { status: 400 }));
      vi.stubGlobal("fetch", upstream);
      const { chatStream } = await import("../llm");
      const onDelta = vi.fn();
      const outcome = chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" })
        .then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4000);
      const failure = await outcome;
      expect(failure).toMatchObject({ name: "LlmResponseError", code: "protocol" });
      expect((failure as Error).message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(onDelta).not.toHaveBeenCalled();
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(recorded.calls).toHaveLength(1);
      expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "protocol", attempts: 0 });
      expect(JSON.stringify(recorded.calls)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(vi.mocked(console.info).mock.calls.flat().join(" ")).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.each(["queued", "in_progress", "cancelled"])("Responses 未完成状态 %s", status => {
  const usage = { input_tokens: 12, output_tokens: 5 };
  it.each([
    { output_text: text },
    { output: [{ type: "message", content: [{ type: "output_text", text }] }] },
    { choices: [{ message: { content: text } }] },
  ])("非流式正文 %j 不能掩盖未完成状态", body => {
    expect(() => parseNonStreamReply("openai_responses", { ...body, status }))
      .toThrow(expect.objectContaining({ code: "incomplete" }));
  });

  it.each(["nonstream", "response.completed", "response.done"])("%s 不发送已缓存 JSON、不重试并保留失败用量", async mode => {
    settings.api_format = "openai_responses";
    const json = { status, output_text: text, usage };
    const stream = event({ type: "response.output_text.delta", delta: text }) +
      event({ type: mode, response: json }) + event("[DONE]");
    const upstream = vi.fn(async () => new Response(stream));
    if (mode === "nonstream") upstream.mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(Response.json(json));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    const onDelta = vi.fn();
    await expect(chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" }))
      .rejects.toMatchObject({ name: "LlmResponseError", code: "incomplete", reason: status === "cancelled" ? "cancelled" : "pending",
        usage: { inputTokens: 12, outputTokens: 5, cachedTokens: null } });
    expect(onDelta).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(mode === "nonstream" ? 2 : 1);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "incomplete", attempts: 0, usage: { inputTokens: 12, outputTokens: 5 } });
  });
});

it("Responses 取消事件没有 status 时也不能被后续完成帧掩盖", async () => {
  settings.api_format = "openai_responses";
  const upstream = vi.fn(async () => new Response(event({ type: "response.output_text.delta", delta: text }) +
    event({ type: "response.cancelled" }) + event({ type: "response.completed", response: { status: "completed" } })));
  vi.stubGlobal("fetch", upstream);
  const { chatStream } = await import("../llm");
  const onDelta = vi.fn();
  await expect(chatStream("parse", [], onDelta, { requireJson: "strict" })).rejects.toMatchObject({ code: "incomplete", reason: "cancelled",
    usage: { inputTokens: null, outputTokens: null, cachedTokens: null } });
  expect(onDelta).not.toHaveBeenCalled();
  expect(upstream).toHaveBeenCalledOnce();
});

it("Responses 正常排队、执行事件之后完成，仍返回完整正文及用量", async () => {
  settings.api_format = "openai_responses";
  const upstream = vi.fn(async () => new Response(event({ type: "response.created", response: { status: "queued" } }) +
    event({ type: "response.in_progress", response: { status: "in_progress" } }) +
    event({ type: "response.output_text.delta", delta: text }) +
    event({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 12, output_tokens: 5 } } })));
  vi.stubGlobal("fetch", upstream);
  const { chatStream } = await import("../llm");
  const onDelta = vi.fn();
  expect(await chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" })).toBe(text);
  expect(onDelta.mock.calls).toEqual([[text]]);
  expect(upstream).toHaveBeenCalledOnce();
  expect(recorded.calls[0]).toMatchObject({ status: "ok", usage: { inputTokens: 12, outputTokens: 5 } });
});

it.each([null, 3, "unknown", []])("Responses 显式无效状态 %j 不能确认完成", status => {
  expect(() => parseNonStreamReply("openai_responses", { status, output_text: text }))
    .toThrow(expect.objectContaining({ code: "protocol" }));
  expect(() => handleSsePayload("openai_responses", JSON.stringify({ type: "response.completed", response: { status } }), () => {}))
    .toThrow(expect.objectContaining({ code: "protocol" }));
});

it.each(["failed", "incomplete"])("Responses %s 失败帧保留提供方上报用量", async status => {
  settings.api_format = "openai_responses";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(event({ type: `response.${status}`, response: {
    status, usage: { input_tokens: 12, output_tokens: 5 },
  } }))));
  const { chat } = await import("../llm");
  await expect(chat("parse", [], { source: { feature: "简历导入解析" } })).rejects.toMatchObject({ code: status === "failed" ? "provider" : "incomplete" });
  expect(recorded.calls[0]).toMatchObject({ status: "failed", usage: { inputTokens: 12, outputTokens: 5 } });
});

it.each([
  { status: "incomplete", upstreamReason: "max_output_tokens", diagnosis: "output_limit" },
  { status: "incomplete", upstreamReason: "content_filter", diagnosis: "content_filter" },
  { status: "incomplete", upstreamReason: "SYNTHETIC_PRIVATE_MARKER", diagnosis: null },
  { status: "incomplete", upstreamReason: "max_output_tokens-SYNTHETIC_PRIVATE_MARKER", diagnosis: null },
  { status: "failed", upstreamReason: "max_output_tokens", diagnosis: null },
])("Responses $status/$upstreamReason 只暴露固定诊断", ({ status, upstreamReason, diagnosis }) => {
  const failure = (() => {
    try { parseNonStreamReply("openai_responses", { status, incomplete_details: { reason: upstreamReason }, output_text: text }); }
    catch (error) { return error; }
  })();
  expect(failure).toMatchObject({ reason: diagnosis, usage: null });
  expect(JSON.stringify(failure)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
});

it.each([undefined, { prompt_tokens: 0, completion_tokens: 0 }])("截断后未解析的末帧用量不补入诊断（已收到=%j）", async usage => {
  settings.api_format = "openai_chat";
  const cancel = vi.fn();
  const upstream = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        event({ choices: [{ delta: {}, finish_reason: "length" }], usage }) +
        event({ choices: [], usage: { prompt_tokens: 99, completion_tokens: 8192 } }) + event("[DONE]")));
    },
    cancel,
  })));
  vi.stubGlobal("fetch", upstream);
  const { chatStream } = await import("../llm");
  const onDelta = vi.fn();
  const failure = await chatStream("parse", [], onDelta, { requireJson: "strict", source: { feature: "简历导入解析" } })
    .then(() => null, (error: unknown) => error);
  const known = { inputTokens: usage ? 0 : null, outputTokens: usage ? 0 : null, cachedTokens: null };
  expect(failure).toMatchObject({ code: "incomplete", reason: "output_limit", usage: known });
  expect(recorded.calls[0]).toMatchObject({ status: "failed", usage: known });
  expect(cancel).toHaveBeenCalledOnce();
  expect(upstream).toHaveBeenCalledOnce();
  expect(onDelta).not.toHaveBeenCalled();
});

it("先前 JSON 重试与最后截断的已观测用量按逻辑调用累计，不多算最后一次", async () => {
  settings.api_format = "openai_chat";
  const upstream = vi.fn()
    .mockResolvedValueOnce(new Response(event({ choices: [{ delta: { content: "invalid json" } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 } }) + event("[DONE]")))
    .mockResolvedValueOnce(new Response(event({ choices: [{ delta: {}, finish_reason: "length" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } })));
  vi.stubGlobal("fetch", upstream);
  vi.useFakeTimers();
  try {
    const { chatStream } = await import("../llm");
    const onDelta = vi.fn();
    const pending = chatStream("parse", [], onDelta, { requireJson: "strict", source: { feature: "简历导入解析" } })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toMatchObject({ code: "incomplete", reason: "output_limit",
      usage: { inputTokens: 30, outputTokens: 8, cachedTokens: 0 } });
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", attempts: 1,
      usage: { inputTokens: 30, outputTokens: 8, cachedTokens: 0 } });
    expect(onDelta).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

const refusalPart = { type: "refusal", refusal: "SYNTHETIC_PRIVATE_MARKER" };
const refusalMessage = { type: "message", content: [{ type: "output_text", text }, refusalPart] };
const refusalReplies: { format: ApiFormat; json: Record<string, unknown> }[] = [
  ...(["openai_chat", "openai_responses"] as const).map(format => ({ format, json: {
    choices: [{ message: { content: text, refusal: "SYNTHETIC_PRIVATE_MARKER" }, finish_reason: "stop" }],
  } })),
  { format: "openai_responses", json: { status: "completed", output: [refusalMessage] } },
  { format: "openai_responses", json: { status: "completed", output_text: text, output: [refusalMessage] } },
  { format: "openai_responses", json: { status: "completed", output: [
    { type: "message", content: [{ type: "output_text", text }] }, { type: "message", content: [refusalPart] },
  ] } },
];
describe.each(refusalReplies)("$format 明确拒绝信号", ({ format, json }) => {
  it("有效正文和 stop / completed 不能覆盖拒绝", () => {
    expect(() => parseNonStreamReply(format, json)).toThrow(expect.objectContaining({ code: "incomplete", message: expect.stringContaining("拒绝") }));
  });
  it("非流式降级不返回已有 JSON，不重试或透出拒绝原文，保留用量", async () => {
    settings.api_format = format;
    const usage = format === "openai_chat" ? { prompt_tokens: 12, completion_tokens: 5 } : { input_tokens: 12, output_tokens: 5 };
    const upstream = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(Response.json({ ...json, usage }));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    const onDelta = vi.fn();
    const failure = await chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" })
      .then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "incomplete", message: expect.stringContaining("拒绝") });
    expect((failure as Error).message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(onDelta).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "incomplete", attempts: 0, usage: { inputTokens: 12, outputTokens: 5 } });
  });
});

const refusalStreams = [
  ...(["openai_chat", "openai_responses"] as const).map(format => ({ format, refusal: { choices: [{ delta: { refusal: "SYNTHETIC_PRIVATE_MARKER" } }] } })),
  ...["response.refusal.delta", "response.refusal.done"].map(type => ({ format: "openai_responses" as const, refusal: { type, delta: "SYNTHETIC_PRIVATE_MARKER", refusal: "SYNTHETIC_PRIVATE_MARKER" } })),
  ...["response.content_part.added", "response.content_part.done"].map(type => ({ format: "openai_responses" as const, refusal: { type, part: refusalPart } })),
  ...["response.output_item.added", "response.output_item.done"].map(type => ({ format: "openai_responses" as const, refusal: { type, item: refusalMessage } })),
  ...["response.completed", "response.done"].map(type => ({ format: "openai_responses" as const, refusal: { type, response: { status: "completed", output: [refusalMessage] } } })),
];
it.each(refusalStreams)("$format 流中拒绝事件 $refusal 不能被已有 JSON 掩盖", async ({ format, refusal }) => {
  settings.api_format = format;
  const prefix = format === "openai_chat"
    ? event({ choices: [{ delta: { content: text } }], usage: { prompt_tokens: 12, completion_tokens: 5 } })
    : event({ type: "response.created", response: { usage: { input_tokens: 12, output_tokens: 5 } } }) + event({ type: "response.output_text.delta", delta: text });
  const upstream = vi.fn(async () => new Response(prefix + event(refusal) + event("[DONE]")));
  vi.stubGlobal("fetch", upstream);
  const { chatStream } = await import("../llm");
  const onDelta = vi.fn();
  const failure = await chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" })
    .then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ code: "incomplete", message: expect.stringContaining("拒绝") });
  expect((failure as Error).message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  expect(onDelta).not.toHaveBeenCalled();
  expect(upstream).toHaveBeenCalledOnce();
  expect(recorded.calls).toHaveLength(1);
  expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "incomplete", attempts: 0, usage: { inputTokens: 12, outputTokens: 5 } });
});

it.each([undefined, null, ""])("Chat 空 refusal=%j 与正文中的 refusal 字样不构成拒绝", refusal => {
  const content = '{"type":"refusal","refusal":"这是普通业务正文"}';
  for (const format of ["openai_chat", "openai_responses"] as const) {
    expect(parseNonStreamReply(format, { choices: [{ message: { content, refusal } }] })).toBe(content);
    const onDelta = vi.fn();
    handleSsePayload(format, JSON.stringify({ choices: [{ delta: { content, refusal } }] }), onDelta);
    expect(onDelta).toHaveBeenCalledWith(content);
  }
  expect(parseNonStreamReply("openai_responses", { output_text: content })).toBe(content);
});

const missingBody: { format: ApiFormat; json: Record<string, unknown> }[] = [
  { format: "anthropic_messages", json: { content: [{ type: "thinking", thinking: text }], stop_reason: "end_turn" } },
  { format: "anthropic_messages", json: { content: [{ type: "text", text: " " }] } },
  { format: "openai_chat", json: { choices: [{ message: { content: null, reasoning_content: text } }] } },
  { format: "openai_chat", json: { choices: [{ message: { content: " ", reasoning: text } }] } },
  { format: "openai_responses", json: { choices: [{ message: { content: null, reasoning_content: text } }] } },
  { format: "openai_responses", json: { output: [{ type: "reasoning", text }] } },
  { format: "openai_responses", json: { output_text: " " } },
];

it.each(missingBody)("$format 正文缺失明确失败，推理不进入最终回复", ({ format, json }) => {
  expect(() => parseNonStreamReply(format, json)).toThrow(LlmResponseError);
  try { parseNonStreamReply(format, json); } catch (error) { expect(error).toMatchObject({ code: "protocol" }); }
});

it.each(["openai_chat", "anthropic_messages", "openai_responses"] as const)("%s 非流式降级拒绝仅推理正文并记录失败", async (format) => {
  settings.api_format = format;
  const json = missingBody.find((entry) => entry.format === format)!.json;
  const upstream = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(Response.json(json));
  vi.stubGlobal("fetch", upstream);
  const { chat } = await import("../llm");
  await expect(chat("parse", [], { source: { feature: "简历导入解析" } })).rejects.toMatchObject({ name: "LlmResponseError", code: "protocol" });
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "protocol" });
});

it.each([
  { format: "anthropic_messages" as const, json: { content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "private" }, { type: "text", text: "B" }] } },
  { format: "openai_chat" as const, json: { choices: [{ message: { content: [{ type: "text", text: "A" }, { type: "reasoning", text: "private" }, { type: "text", text: "B" }], reasoning: "private" } }] } },
  { format: "openai_responses" as const, json: { output: [{ type: "reasoning", text: "private" }, { type: "message", content: [{ type: "output_text", text: "A" }, { type: "text", text: "B" }] }] } },
])("$format 按顺序拼接全部正式正文块", ({ format, json }) => {
  expect(parseNonStreamReply(format, json)).toBe("AB");
});

it("Responses 流式推理 delta 不作为正文输出", () => {
  const deltas: string[] = [];
  handleSsePayload("openai_responses", JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "private" }), (delta) => deltas.push(delta));
  handleSsePayload("openai_responses", JSON.stringify({ type: "response.output_text.delta", delta: "answer" }), (delta) => deltas.push(delta));
  expect(deltas).toEqual(["answer"]);
});

it("Anthropic 正文块初始文本和后续增量都属于正式正文", () => {
  const deltas: string[] = [];
  handleSsePayload("anthropic_messages", JSON.stringify({ type: "content_block_start", content_block: { type: "text", text: "A" } }), (delta) => deltas.push(delta));
  handleSsePayload("anthropic_messages", JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "B" } }), (delta) => deltas.push(delta));
  expect(deltas.join("")).toBe("AB");
});

it.each([
  { format: "openai_chat" as const, json: { choices: [{ message: { content: "answer", reasoning_content: "private", reasoning: "private" }, finish_reason: "stop" }] } },
  { format: "openai_chat" as const, json: { choices: [{ text: "answer" }] } },
  { format: "anthropic_messages" as const, json: { content: [{ type: "text", text: "answer" }], stop_reason: "end_turn" } },
  { format: "openai_responses" as const, json: { output_text: "answer", status: "completed" } },
  { format: "openai_responses" as const, json: { output_text: "", output: [{ content: [{ type: "output_text", text: "answer" }] }] } },
  { format: "openai_responses" as const, json: { choices: [{ message: { content: "answer", reasoning_content: "private" } }] } },
])("$format 保留正常正文和已有网关正文兼容", ({ format, json }) => {
  expect(parseNonStreamReply(format, json)).toBe("answer");
});

it.each([
  { format: "openai_chat" as const, stream: event({ choices: [{ delta: { reasoning_content: "private", reasoning: "private" } }] }) + event("[DONE]") },
  { format: "anthropic_messages" as const, stream: event({ type: "content_block_start", content_block: { type: "thinking", thinking: "private" } }) + event({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } }) + event({ type: "message_stop" }) },
  { format: "openai_responses" as const, stream: event({ type: "response.reasoning_summary_text.delta", delta: "private" }) + event({ type: "response.completed", response: { status: "completed" } }) },
])("$format 流式只有推理时仍明确失败并且不发出正文", async ({ format, stream }) => {
  settings.api_format = format;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
  const { chatStream } = await import("../llm");
  const onDelta = vi.fn();
  await expect(chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" } })).rejects.toMatchObject({ name: "LlmResponseError", code: "protocol" });
  expect(onDelta).not.toHaveBeenCalled();
  expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "protocol" });
});
