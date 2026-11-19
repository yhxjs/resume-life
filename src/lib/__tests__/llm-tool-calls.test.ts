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

const text = '{"result":"完整业务正文，不代表工具已执行"}';
const marker = "SYNTHETIC_PRIVATE_MARKER";
const fn = { name: "unrequested", arguments: JSON.stringify({ material: marker }) };
const tool = { type: "function_call", call_id: "synthetic", ...fn };
const usage = { input_tokens: 12, output_tokens: 5, prompt_tokens: 12, completion_tokens: 5 };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chatFields = [{ tool_calls: [{ index: 0, type: "function", function: fn }] }, { function_call: fn }];
const nonstream = (["openai_chat", "openai_responses"] as const).flatMap(format => chatFields.map(fields => ({
  name: `${format}/${Object.keys(fields)[0]}`, format,
  json: { choices: [{ message: { content: text, ...fields }, finish_reason: "stop" }], usage },
}))) as { name: string; format: ApiFormat; json: unknown }[];
nonstream.push({ name: "responses/output_text + function_call", format: "openai_responses",
  json: { status: "completed", output_text: text, output: [tool], usage } });
nonstream.push({ name: "responses/native message + function_call", format: "openai_responses",
  json: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }, tool], usage } });

const streaming = (["openai_chat", "openai_responses"] as const).flatMap(format => chatFields.map(fields => ({
  name: `${format}/${Object.keys(fields)[0]}`, format,
  prefix: event({ choices: [{ delta: { content: text } }], usage }),
  invocation: { choices: [{ delta: fields, finish_reason: "stop" }] },
}))) as { name: string; format: ApiFormat; prefix: string; invocation: unknown }[];
for (const type of ["response.output_item.added", "response.output_item.done", "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.completed"]) {
  streaming.push({ name: type, format: "openai_responses",
    prefix: event({ type: "response.created", response: { usage } }) + event({ type: "response.output_text.delta", delta: text }),
    invocation: { type, ...(type.startsWith("response.output_item.") ? { item: tool }
      : type === "response.completed" ? { response: { status: "completed", output: [tool] } }
        : { delta: fn.arguments, arguments: fn.arguments }) },
  });
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-tools-"));
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
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("resume-life-tools-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(root, { recursive: true, force: true });
});

describe("明确工具调用不能被完整正文或 stop/completed 掩盖", () => {
  it.each(nonstream)("$name 非流式直接拒绝", ({ format, json }) => {
    expect(() => parseNonStreamReply(format, json)).toThrow(expect.objectContaining({ code: "protocol", message: expect.stringContaining("工具调用") }));
  });

  it.each(streaming)("$name 事件拒绝且不输出参数", ({ format, invocation }) => {
    const onDelta = vi.fn();
    expect(() => handleSsePayload(format, JSON.stringify(invocation), onDelta)).toThrow(expect.objectContaining({ code: "protocol", message: expect.stringContaining("工具调用") }));
    expect(onDelta).not.toHaveBeenCalled();
  });

  it.each([
    ...nonstream.map(item => ({ ...item, fallback: true, wire: JSON.stringify(item.json) })),
    ...streaming.map(item => ({ ...item, fallback: false, wire: item.prefix + event(item.invocation) + "data: [DONE]\n\n" })),
  ])("$name fallback=$fallback：不发缓存、不重试，失败记录保留用量", async ({ format, fallback, wire }) => {
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

  it.each(["openai_chat", "openai_responses"] as const)("%s 保留空工具字段及正文同名业务字段", format => {
    const content = JSON.stringify({ tool_calls: [{ name: "正文中的字段" }], function_call: "业务数据" });
    for (const fields of [{}, { tool_calls: null, function_call: null }, { tool_calls: [] }]) {
      expect(parseNonStreamReply(format, { choices: [{ message: { content, ...fields }, finish_reason: "stop" }] })).toBe(content);
      const onDelta = vi.fn();
      handleSsePayload(format, JSON.stringify({ choices: [{ delta: { content, ...fields } }] }), onDelta);
      expect(onDelta).toHaveBeenCalledWith(content);
    }
  });

  it("Responses reasoning 及普通 output item 仍可完成", () => {
    const message = { type: "message", content: [{ type: "output_text", text }] };
    expect(parseNonStreamReply("openai_responses", { status: "completed", output: [{ type: "reasoning", summary: [] }, message] })).toBe(text);
    expect(handleSsePayload("openai_responses", JSON.stringify({ type: "response.output_item.added", item: message }), vi.fn())).toBeUndefined();
  });
});
