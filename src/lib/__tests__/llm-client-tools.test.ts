import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSsePayload, parseNonStreamReply } from "../llm-adapter";
import type { ApiFormat } from "../settings-constants";

const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../llm-call-log", () => ({ recordLlmCall: (entry: Record<string, unknown>) => recorded.calls.push(entry) }));

const marker = "SYNTHETIC_PRIVATE_MARKER";
const text = '{"result":"合法正文，工具尚未执行"}';
const custom = { type: "custom_tool_call", call_id: "synthetic", name: "unrequested", input: marker, status: "completed" };
const anthropic = { type: "tool_use", id: "synthetic", name: "unrequested", input: { material: marker } };
const usage = { input_tokens: 12, output_tokens: 5 };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const nonstream: { name: string; format: ApiFormat; json: unknown }[] = [
  ...[undefined, "end_turn"].map(stop_reason => ({ name: `Anthropic/stop=${stop_reason}`, format: "anthropic_messages" as const,
    json: { content: [{ type: "text", text }, anthropic], stop_reason, usage } })),
  { name: "Responses/output_text", format: "openai_responses", json: { status: "completed", output_text: text, output: [custom], usage } },
  { name: "Responses/message", format: "openai_responses", json: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }, custom], usage } },
];
const streaming: { name: string; format: ApiFormat; prefix: string; invocation: unknown; done: string }[] = [
  { name: "Anthropic/content_block_start", format: "anthropic_messages",
    prefix: event({ type: "message_start", message: { usage } }) + event({ type: "content_block_delta", delta: { type: "text_delta", text } }),
    invocation: { type: "content_block_start", content_block: anthropic }, done: event({ type: "message_stop" }) },
  { name: "Anthropic/input_json_delta", format: "anthropic_messages",
    prefix: event({ type: "message_start", message: { usage } }) + event({ type: "content_block_delta", delta: { type: "text_delta", text } }),
    invocation: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: marker } }, done: event({ type: "message_stop" }) },
  { name: "Anthropic/message_start content", format: "anthropic_messages", prefix: "",
    invocation: { type: "message_start", message: { content: [{ type: "text", text }, anthropic], usage } },
    done: event({ type: "content_block_delta", delta: { type: "text_delta", text } }) + event({ type: "message_stop" }) },
];
for (const type of ["response.output_item.added", "response.output_item.done", "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done", "response.completed", "response.done"]) {
  streaming.push({ name: type, format: "openai_responses",
    prefix: event({ type: "response.created", response: { usage } }) + event({ type: "response.output_text.delta", delta: text }),
    invocation: { type, ...(type.startsWith("response.output_item.") ? { item: custom }
      : ["response.completed", "response.done"].includes(type) ? { response: { status: "completed", output: [custom] } }
        : { delta: marker, input: marker }) },
    done: "data: [DONE]\n\n",
  });
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-client-tools-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", root);
  vi.resetModules();
  recorded.calls.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("resume-life-client-tools-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(root, { recursive: true, force: true });
});

describe("自定义工具及 Anthropic 客户端调用不能当成最终正文", () => {
  it.each(nonstream)("$name 非流式拒绝混合正文", ({ format, json }) => {
    expect(() => parseNonStreamReply(format, json)).toThrow(expect.objectContaining({ code: "protocol", message: expect.stringContaining("工具调用") }));
  });
  it.each(streaming)("$name 事件拒绝且不输出调用输入", ({ format, invocation }) => {
    const onDelta = vi.fn();
    expect(() => handleSsePayload(format, JSON.stringify(invocation), onDelta)).toThrow(expect.objectContaining({ code: "protocol", message: expect.stringContaining("工具调用") }));
    expect(onDelta).not.toHaveBeenCalled();
  });
  it.each([
    ...nonstream.map(item => ({ ...item, fallback: true, wire: JSON.stringify(item.json) })),
    ...streaming.map(item => ({ ...item, fallback: false, wire: item.prefix + event(item.invocation) + item.done })),
  ])("$name fallback=$fallback：整次失败、不重试、不外发缓存或参数", async ({ format, fallback, wire }) => {
    settings.api_format = format;
    const upstream = vi.fn(async () => new Response(wire));
    if (fallback) upstream.mockResolvedValueOnce(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    vi.useFakeTimers();
    const onDelta = vi.fn();
    const outcome = chatStream("parse", [], onDelta, { requireJson: "strict", source: { feature: "简历导入解析" } }).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4000);
    const failure = await outcome;
    expect(failure).toMatchObject({ code: "protocol", message: expect.stringContaining("工具调用") });
    expect((failure as Error).message).not.toContain(marker);
    expect((failure as Error).cause).toBeUndefined();
    expect(onDelta).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(fallback ? 2 : 1);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "protocol", attempts: 0, usage: { inputTokens: 12, outputTokens: 5 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Anthropic 思考事件及正文中的 tool_use 业务字段不误拒绝", () => {
    const content = JSON.stringify({ type: "tool_use", input: marker });
    expect(parseNonStreamReply("anthropic_messages", { content: [{ type: "thinking", thinking: marker }, { type: "text", text: content }], stop_reason: "end_turn" })).toBe(content);
    const onDelta = vi.fn();
    handleSsePayload("anthropic_messages", JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: marker } }), onDelta);
    handleSsePayload("anthropic_messages", JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: content } }), onDelta);
    expect(onDelta.mock.calls).toEqual([[content]]);
  });
  it("Responses 正文中同名字段及正常 output item 不误拒绝", () => {
    const content = JSON.stringify(custom);
    expect(parseNonStreamReply("openai_responses", { status: "completed", output_text: content, output: [{ type: "reasoning", summary: [] }] })).toBe(content);
    expect(handleSsePayload("openai_responses", JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: content }] } }), vi.fn())).toBeUndefined();
  });
});
