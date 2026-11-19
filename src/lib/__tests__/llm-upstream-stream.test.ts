import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFormat } from "../settings-constants";
const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
const database = vi.hoisted(() => ({ getDb: vi.fn(() => { throw new Error("失败响应不应触及数据库"); }) }));
const metering = vi.hoisted(() => ({ recordLlmCall: vi.fn() }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../db", () => ({ requestDataGeneration: () => null, getDb: database.getDb, now: () => "2026-09-16" }));
vi.mock("../llm-call-log", () => metering);
import { chat, chatStream, LLM_MAX_RESPONSE_BYTES, LLM_MAX_SSE_FRAME_BYTES, LLM_MAX_SSE_RESPONSE_BYTES } from "../llm";
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

function respond(source: string, chunkBytes = 7) {
  const fetch = vi.fn().mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(source);
    // 切开 UTF-8、data 行和 JSON，验证跨网络块处理。
    for (let index = 0; index < bytes.length; index += chunkBytes) controller.enqueue(bytes.slice(index, index + chunkBytes));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** 保持流打开，以实际 pull/cancel 检查完成或拒绝后不再读取后续块。 */
function respondOnDemand(chunks: Iterable<string>) {
  const iterator = chunks[Symbol.iterator]();
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const next = iterator.next();
    if (!next.done) controller.enqueue(new TextEncoder().encode(next.value));
  });
  const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })));
  vi.stubGlobal("fetch", fetch);
  return { fetch, cancel, pull };
}

function* paddedWire(frame: string, size: number, tail = protocols[0]!.done) {
  const first = protocols[0]!.delta;
  let padding = size - Buffer.byteLength(first + tail);
  yield first;
  const frameBytes = Buffer.byteLength(frame);
  while (padding >= frameBytes + 3) {
    yield frame;
    padding -= frameBytes;
  }
  // 注释也必须消耗原始传输预算；至少保留 ":\n\n" 三字节。
  yield ":" + " ".repeat(padding - 3) + "\n\n";
  yield tail;
  yield "data: should-not-be-read\n\n";
}

describe.each(protocols)("$format 上游流终态", ({ format, delta, done, error }) => {
  it.each(["\n", "\r\n", "\r"].flatMap(newline => ([false, "strict"] as const).map(requireJson => [newline, requireJson] as const)))("多行 data 事件支持换行 %j，requireJson=%s，跨字节分块且只发送完整正文", async (newline, requireJson) => {
    settings.api_format = format;
    const prettyEvent = (wireEvent: string) => {
      const payload = wireEvent.slice(6).trim();
      const lines = payload === "[DONE]" ? [payload] : JSON.stringify(JSON.parse(payload), null, 2).split("\n");
      return ["event: message", "id: synthetic", ": keep-alive", ...lines.map((line, index) =>
        `${index % 2 ? "data:" : "data: "}${line}`), "", ""].join(newline);
    };
    const fetch = respond(prettyEvent(delta) + prettyEvent(done), 1);
    const onDelta = vi.fn();
    expect(await chatStream("parse", [], onDelta, { requireJson })).toBe(text);
    expect(onDelta.mock.calls).toEqual([[text]]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("同一事件的多个 data 行先合并校验，不能发出其中可单独解析的前半行", async () => {
    settings.api_format = format;
    const fetch = respond(delta.trimEnd() + "\ndata: {SYNTHETIC_PRIVATE_MARKER:broken\n\n" + done);
    const onDelta = vi.fn();
    await expect(chatStream("parse", [], onDelta)).rejects.toMatchObject({ code: "protocol" });
    expect(onDelta).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("有协议完成事件才返回完整文本", async () => {
    settings.api_format = format;
    respond(delta + done.trimEnd());
    expect(await chat("parse", [])).toBe(text);
  });

  it("单独 CR 结束完成帧时无需等待连接关闭，随后取消读取", async () => {
    settings.api_format = format;
    const cancel = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode((delta + done).replaceAll("\n", "\r"))); },
      cancel,
    })));
    vi.stubGlobal("fetch", fetch);
    expect(await chat("parse", [])).toBe(text);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
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

  it.each(["null", "[]", "true", "3", '"SYNTHETIC_PRIVATE_MARKER"'])("非对象事件 %s 不能被已有 JSON 和完成帧掩盖，也不应当作网络错误重试", async payload => {
    settings.api_format = format;
    const fetch = respond(delta + event(payload) + done);
    const onDelta = vi.fn();
    const outcome = chatStream("parse", [], onDelta, { requireJson: "strict" })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4000);
    const failure = await outcome;
    expect(failure).toBeInstanceOf(LlmResponseError);
    expect(failure).toMatchObject({ code: "protocol" });
    expect((failure as Error).message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(onDelta).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
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

it("同一 SSE 事件累计超过单帧预算时拒绝，不能用多条短 data 行绕过", async () => {
  settings.api_format = "openai_chat";
  const line = `data: ${" ".repeat(1024)}\n`;
  const wire = "data: {\n" + line.repeat(Math.ceil(LLM_MAX_SSE_FRAME_BYTES / line.length)) +
    'data: "choices":[{"delta":{"content":"不应外发"}}]}\n\n' + event("[DONE]");
  const fetch = vi.fn().mockResolvedValue(new Response(wire));
  vi.stubGlobal("fetch", fetch);
  const onDelta = vi.fn();
  await expect(chatStream("parse", [], onDelta)).rejects.toThrow(/SSE.*超过/);
  expect(onDelta).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["\n", "\r\n", "\r"])("规范化换行为 %j 时单帧按 UTF-8 字节接受恰好上限，超一字节拒绝且不发正文", async newline => {
  settings.api_format = "openai_chat";
  const seed = "文".repeat(100);
  const payload = (content: string) => ({ choices: [{ delta: { content } }] });
  const text = seed + "x".repeat(LLM_MAX_SSE_FRAME_BYTES - Buffer.byteLength(event(payload(seed))));
  const wire = (content: string) => (event(payload(content)) + event("[DONE]")).replaceAll("\n", newline);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(wire(text))).mockResolvedValueOnce(new Response(wire(text + "x")));
  vi.stubGlobal("fetch", fetch);
  expect(await chat("parse", [])).toBe(text);
  const onDelta = vi.fn();
  await expect(chatStream("parse", [], onDelta)).rejects.toThrow(/SSE.*超过/);
  expect(onDelta).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("合法逐片推理的传输超过 2 MiB，仍可接收小正文与完成事件", async () => {
  settings.api_format = "openai_chat";
  const reasoning = event({
    id: "synthetic-completion-" + "a".repeat(48), object: "chat.completion.chunk",
    created: 1_700_000_000, model: "synthetic-reasoning-model", system_fingerprint: "synthetic-fingerprint",
    choices: [{ index: 0, delta: { reasoning_content: "分析", content: "" }, finish_reason: null }],
  });
  const body = reasoning.repeat(8000) + protocols[0]!.delta + protocols[0]!.done;
  expect(Buffer.byteLength(body)).toBeGreaterThan(LLM_MAX_RESPONSE_BYTES);
  const fetch = respond(body, 64 * 1024);
  const onDelta = vi.fn();
  expect(await chatStream("parse", [], onDelta, { requireJson: "strict", maxTokens: 8192 })).toBe(text);
  expect(onDelta.mock.calls).toEqual([[text]]);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { name: "推理", frame: event({ choices: [{ delta: { reasoning_content: "r".repeat(512), content: "" } }] }) },
  { name: "未知事件", frame: event({ type: "synthetic_extension", payload: "x".repeat(512) }) },
  { name: "注释心跳", frame: ":" + " ".repeat(512) + "\r\n\r\n" },
])("$name 同样消耗 SSE 传输预算，恰好 8 MiB 成功、完成前超一字节拒绝", async ({ frame }) => {
  settings.api_format = "openai_chat";
  for (const extra of [0, 1]) {
    const chunks = [...paddedWire(frame, LLM_MAX_SSE_RESPONSE_BYTES + extra)];
    expect(Buffer.byteLength(chunks.slice(0, -1).join(""))).toBe(LLM_MAX_SSE_RESPONSE_BYTES + extra);
    const upstream = respondOnDemand(chunks);
    const onDelta = vi.fn();
    const run = chatStream("parse", [], onDelta, { requireJson: "strict", source: { feature: "简历导入解析" } });
    if (extra) {
      await expect(run).rejects.toMatchObject({ message: "LLM 响应超过字节上限", code: "protocol" });
      expect(onDelta).not.toHaveBeenCalled();
      expect(metering.recordLlmCall).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", errorCode: "protocol", attempts: 0 }));
    } else {
      expect(await run).toBe(text);
      expect(onDelta.mock.calls).toEqual([[text]]);
    }
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.pull).toHaveBeenCalledTimes(chunks.length - 1);
    expect(upstream.fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  }
});

it.each([false, "strict"] as const)("SSE 可见正文仍按 UTF-8 限制 2 MiB，requireJson=%s 时拒绝越界增量", async (requireJson) => {
  settings.api_format = "openai_chat";
  for (const extra of [0, 1]) {
    const payloadBytes = LLM_MAX_RESPONSE_BYTES + extra - Buffer.byteLength('{"value":""}');
    const output = '{"value":"' + "界".repeat(Math.floor(payloadBytes / 3)) + "x".repeat(payloadBytes % 3) + '"}';
    expect(Buffer.byteLength(output)).toBe(LLM_MAX_RESPONSE_BYTES + extra);
    const deltas: string[] = [];
    for (let i = 0; i < output.length; i += 16_384) deltas.push(output.slice(i, i + 16_384));
    const chunks = deltas.map(content => event({ choices: [{ delta: { content } }] }));
    const frameCount = chunks.length;
    chunks.push(protocols[0]!.done, "data: should-not-be-read\n\n");
    expect(Buffer.byteLength(chunks.join(""))).toBeLessThan(LLM_MAX_SSE_RESPONSE_BYTES);
    const upstream = respondOnDemand(chunks);
    const onDelta = vi.fn();
    const run = chatStream("parse", [], onDelta, { requireJson, source: { feature: "简历导入解析" } });
    if (extra) {
      await expect(run).rejects.toMatchObject({ message: "LLM 响应内容超过字节上限", code: "protocol" });
      expect(onDelta.mock.calls).toEqual(requireJson === "strict" ? [] : deltas.slice(0, -1).map(delta => [delta]));
      expect(metering.recordLlmCall).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", errorCode: "protocol", attempts: 0 }));
    } else {
      expect(await run).toBe(output);
      expect(onDelta.mock.calls).toEqual(requireJson === "strict" ? [[output]] : deltas.map(delta => [delta]));
      expect(metering.recordLlmCall).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok", attempts: 0 }));
    }
    expect(upstream.pull).toHaveBeenCalledTimes(frameCount + (extra ? 0 : 1));
    expect(upstream.cancel).toHaveBeenCalledOnce();
    expect(upstream.fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  }
});

it("超过旧传输预算后的正文仍须等待 DONE，EOF 不返回部分 JSON", async () => {
  settings.api_format = "openai_chat";
  const chunks = [...paddedWire(": synthetic keep-alive\n\n", LLM_MAX_RESPONSE_BYTES + 4096, "")].slice(0, -1);
  const fetch = respond(chunks.join(""), 64 * 1024);
  const onDelta = vi.fn();
  await expect(chatStream("parse", [], onDelta, { requireJson: "strict" })).rejects.toMatchObject({ code: "protocol", message: expect.stringMatching(/中断|完成/) });
  expect(onDelta).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 1])("非流式降级响应体仍限制 2 MiB，超出 %i 字节", async (extra) => {
  settings.api_format = "openai_chat";
  const reply = { choices: [{ message: { content: text } }], padding: "" };
  reply.padding = "x".repeat(LLM_MAX_RESPONSE_BYTES + extra - Buffer.byteLength(JSON.stringify(reply)));
  const body = JSON.stringify(reply);
  expect(Buffer.byteLength(body)).toBe(LLM_MAX_RESPONSE_BYTES + extra);
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("stream unsupported", { status: 400 }))
    .mockResolvedValueOnce(new Response(body));
  vi.stubGlobal("fetch", fetch);
  const onDelta = vi.fn();
  const run = chatStream("parse", [], onDelta, { requireJson: "strict", source: { feature: "简历导入解析" } });
  if (extra) {
    await expect(run).rejects.toMatchObject({ message: "LLM 响应超过字节上限", code: "protocol" });
    expect(onDelta).not.toHaveBeenCalled();
    expect(metering.recordLlmCall).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", errorCode: "protocol", attempts: 0 }));
  } else {
    expect(await run).toBe(text);
    expect(onDelta.mock.calls).toEqual([[text]]);
    expect(metering.recordLlmCall).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok", attempts: 0 }));
  }
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
  const validResult = JSON.stringify({
    target_summary: "信息不足", punchline: "需核实实际安排", overall_risk_score: 1,
    risk_ratings: { overtime: 1, stability: 1, resources: 1, management: 1 }, items: [],
    company_profile: { team_style: "信息不足", risk_flags: [], culture_summary: "当前输入不足以判断实际工作条件。" },
    golden_questions: ["团队日常如何排期？", "能否介绍最近一次项目的协作安排？"],
  });
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
