import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFormat } from "../settings-constants";
const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
const database = vi.hoisted(() => ({ getDb: vi.fn(() => { throw new Error("失败响应不应触及数据库"); }) }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../db", () => ({ requestDataGeneration: () => null, getDb: database.getDb, now: () => "2026-09-16" }));
vi.mock("../llm-call-log", () => ({ recordLlmCall: () => {} }));
import { chat, chatStream, LLM_MAX_RESPONSE_BYTES, LLM_MAX_SSE_FRAME_BYTES } from "../llm";
import { buildRequestBody, LlmResponseError, parseNonStreamReply } from "../llm-adapter";
import { POST as decodeJargon } from "../../app/api/tools/jargon-decodings/route";

const text = '{"result":"完整可解析的 JSON"}';
const event = (data: unknown) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const protocols: { format: ApiFormat; delta: string; done: string; error: string }[] = [
  { format: "openai_chat", delta: event({ choices: [{ delta: { content: text } }] }), done: event("[DONE]"), error: event({ error: { message: "synthetic failure" } }) },
  { format: "anthropic_messages", delta: event({ type: "content_block_delta", delta: { type: "text_delta", text } }), done: event({ type: "message_stop" }), error: event({ type: "error", error: { message: "synthetic failure" } }) },
  { format: "openai_responses", delta: event({ type: "response.output_text.delta", delta: text }), done: event({ type: "response.completed", response: { status: "completed" } }), error: event({ type: "response.failed", response: { error: { message: "synthetic failure" } } }) },
];
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function rejectsAfterRetries(run: Promise<string>, pattern?: RegExp) {
  const outcome = run.then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(4000);
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  if (pattern && error instanceof Error) expect(error.message).toMatch(pattern);
}

function respond(source: string) {
  const fetch = vi.fn().mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(source);
    // 切开 UTF-8、data 行和 JSON，验证跨网络块处理。
    for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe.each(protocols)("$format 上游流终态", ({ format, delta, done, error }) => {
  it("有协议完成事件才返回完整文本", async () => {
    settings.api_format = format;
    respond(delta + done.trimEnd());
    expect(await chat("parse", [])).toBe(text);
  });

  it.each(["chat", "chatStream"])("%s：即使 delta 是有效 JSON，无终态 EOF 也不能成功", async (mode) => {
    settings.api_format = format;
    respond(delta);
    const run = mode === "chat" ? chat("parse", []) : chatStream("parse", [], () => {});
    await rejectsAfterRetries(run, /中断|完成/);
  });

  it("已有文本后的协议错误不能作为成功回复", async () => {
    settings.api_format = format;
    respond(delta + error + done);
    await rejectsAfterRetries(chat("parse", []));
  });

  it.each(["chat", "chatStream"])("%s：损坏 data 后的文本与完成事件不能把响应变成成功", async (mode) => {
    settings.api_format = format;
    const fetch = respond(delta.replace("完整可解析的 JSON", "A") + event('{SYNTHETIC_PRIVATE_MARKER:bad-json') +
      delta.replace("完整可解析的 JSON", "C") + done);
    const deltas: string[] = [];
    const run = mode === "chat" ? chat("parse", []) : chatStream("parse", [], (value) => deltas.push(value));
    const error = await run.then(() => null, (error: unknown) => error);
    expect(error).toBeInstanceOf(LlmResponseError);
    expect(error).toMatchObject({ code: "protocol" });
    expect((error as Error).message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(fetch).toHaveBeenCalledOnce();
    if (mode === "chatStream") expect(deltas).toEqual(['{"result":"A"}']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("合法注释、空 data 心跳与 ping 不影响完成", async () => {
    settings.api_format = format;
    respond(": keep-alive\n\nevent: ping\n\ndata: \n\n" + event({ type: "ping" }) + delta + done);
    expect(await chat("parse", [])).toBe(text);
  });

  it("读取中取消不返回部分文本，也不重试", async () => {
    settings.api_format = format;
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, options: RequestInit) => Promise.resolve(new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(delta));
      options.signal!.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), { once: true });
    } }), { headers: { "content-type": "text/event-stream" } })));
    vi.stubGlobal("fetch", fetch);
    await expect(chatStream("parse", [], () => controller.abort(), { signal: controller.signal })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("流式请求附带 Accept: text/event-stream 请求头", async () => {
    settings.api_format = format;
    const fetch = respond(delta + done.trimEnd());
    await chat("parse", []);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/event-stream",
        }),
      })
    );
  });
});

it("Anthropic 协议在收到带有 end_turn 的 message_delta 但未收到 message_stop 时也能完成", async () => {
  settings.api_format = "anthropic_messages";
  const delta = event({ type: "content_block_delta", delta: { type: "text_delta", text } });
  const stopDelta = event({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  respond(delta + stopDelta);
  expect(await chat("parse", [])).toBe(text);
});

it.each(["failed", "incomplete"])("Responses %s 事件不接受已生成 JSON", async (status) => {
  settings.api_format = "openai_responses";
  const fetch = respond(protocols[2]!.delta + event({ type: `response.${status}`, response: { status, incomplete_details: { reason: "max_output_tokens-SYNTHETIC_PRIVATE_MARKER" } } }));
  await rejectsAfterRetries(chat("parse", []), /失败|未完成/);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.mocked(console.info).mock.calls.flat().join(" ")).not.toContain("SYNTHETIC_PRIVATE_MARKER");
});

it("HTTP error body is not written to logs or exception text", async () => {
  settings.api_format = "openai_chat";
  const fetch = vi.fn().mockResolvedValue(new Response("SYNTHETIC_PRIVATE_MARKER", { status: 401 }));
  vi.stubGlobal("fetch", fetch);
  const error = await chat("parse", []).then(() => null, (value: unknown) => value);
  expect(fetch).toHaveBeenCalledOnce();
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  expect(vi.mocked(console.info).mock.calls.flat().join(" ")).not.toContain("SYNTHETIC_PRIVATE_MARKER");
});

it("SSE 单帧过大时立即拒绝", async () => {
  settings.api_format = "openai_chat";
  const fetch = vi.fn().mockResolvedValue(new Response(`data: ${"x".repeat(LLM_MAX_SSE_FRAME_BYTES)}\n\n`,
    { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(chat("parse", [])).rejects.toThrow(/SSE.*超过/);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("SSE 总响应超过字节预算时拒绝并停止读取", async () => {
  settings.api_format = "openai_chat";
  const frame = event({ choices: [{ delta: { content: "x".repeat(2048) } }] });
  const fetch = vi.fn().mockResolvedValue(new Response(frame.repeat(Math.ceil(LLM_MAX_RESPONSE_BYTES / frame.length) + 1),
    { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(chat("parse", [])).rejects.toThrow(/响应.*超过/);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("非流式降级响应超过字节预算时拒绝", async () => {
  settings.api_format = "openai_chat";
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("stream unsupported", { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "x".repeat(LLM_MAX_RESPONSE_BYTES) } }] })));
  vi.stubGlobal("fetch", fetch);
  await expect(chat("parse", [])).rejects.toThrow(/响应.*超过/);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("LLM 调用日志带上传入的 requestId，可据此串起整条因果链", async () => {
  settings.api_format = "openai_chat";
  respond(protocols[0]!.delta + protocols[0]!.done.trimEnd());
  await chatStream("parse", [], undefined, { requestId: "trace-me-42" });
  const logged = vi.mocked(console.info).mock.calls.flat().join(" ");
  expect(logged).toContain("[server-info]");
  expect(logged).toContain("llm.request");
  expect(logged).toContain("trace-me-42");
});

it("Responses 完成事件内的失败状态不能伪装完成", async () => {  settings.api_format = "openai_responses";
  respond(protocols[2]!.delta + event({ type: "response.completed", response: { status: "incomplete" } }));
  await rejectsAfterRetries(chat("parse", []));
});

it.each(["failed", "incomplete"])("Responses 非流式降级同样拒绝 %s 状态", (status) => {
  expect(() => parseNonStreamReply("openai_responses", { status, output: [{ content: [{ type: "output_text", text }] }] })).toThrow();
});

describe("多模态请求体构造", () => {
  it("针对 openai_responses 格式正确将图片映射为 input_image", () => {
    const body = buildRequestBody({
      format: "openai_responses",
      model: "gpt-6-sol",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "识别文字" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
      ],
      maxTokens: 100,
      stream: false,
    });

    const input = body.input as Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string }> }>;
    expect(input[0]?.content[0]).toEqual({ type: "input_text", text: "识别文字" });
    expect(input[0]?.content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,abc" });
  });

  it("针对 anthropic_messages 格式正确将 DataURL 映射为 base64 source 结构", () => {
    const body = buildRequestBody({
      format: "anthropic_messages",
      model: "claude-3-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "识别" },
            { type: "image_url", image_url: { url: "data:image/png;base64,xyz123" } },
          ],
        },
      ],
      maxTokens: 100,
      stream: false,
    });

    const messages = body.messages as Array<{ role: string; content: Array<{ type: string; source?: { type: string; data: string; media_type: string } }> }>;
    expect(messages[0]?.content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "xyz123",
      },
    });
  });
});

it("保留 Responses 网关 response.done 完成事件兼容", async () => {
  settings.api_format = "openai_responses";
  respond(protocols[2]!.delta + event({ type: "response.done" }));
  expect(await chat("parse", [])).toBe(text);
});

it.each(["eof", "failed", "incomplete"])("真实解码路由在上游 %s 后返回 502，不保存已生成的合法业务 JSON", async (status) => {
  settings.api_format = "openai_responses";
  const validResult = JSON.stringify({ items: [{ keyword: "合成暗号", risk_level: "low" }] });
  respond(event({ type: "response.output_text.delta", delta: validResult }) +
    (status === "eof" ? "" : event({ type: `response.${status}`, response: { status } })));
  const request = new Request("http://localhost/api/tools/jargon-decodings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"text":"合成输入"}',
  });
  const [response] = await Promise.all([decodeJargon(request), vi.advanceTimersByTimeAsync(4000)]);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
  expect(database.getDb).not.toHaveBeenCalled();
});

describe("buildRequestBody 的 stream_options 注入", () => {
  const base = {
    model: "synthetic-model",
    messages: [{ role: "user" as const, content: "合成输入" }],
    maxTokens: 32,
  };

  it("openai_chat 流式请求注入 include_usage，让上游在流式响应中回传 usage", () => {
    const body = buildRequestBody({ ...base, format: "openai_chat", stream: true });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("openai_chat 非流式请求不注入 stream_options", () => {
    const body = buildRequestBody({ ...base, format: "openai_chat", stream: false });
    expect(body).not.toHaveProperty("stream_options");
  });

  it.each(["anthropic_messages", "openai_responses"] as const)(
    "%s 无论流式与否都不注入 stream_options",
    (format) => {
      for (const stream of [true, false]) {
        expect(buildRequestBody({ ...base, format, stream })).not.toHaveProperty("stream_options");
      }
    },
  );
});
