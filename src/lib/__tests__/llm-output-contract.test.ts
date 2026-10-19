import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFormat } from "../settings-constants";
import { handleSsePayload, LlmResponseError, parseNonStreamReply } from "../llm-adapter";

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
    try { parseNonStreamReply(format, json); } catch (error) { expect(error).toMatchObject({ code: "incomplete" }); }
  });

  it.each([false, true])("流式=%s：后续完成事件不能把截断转为成功，并记录失败用量", async (useStream) => {
    settings.api_format = format;
    const upstream = vi.fn(async () => new Response(stream));
    if (!useStream) upstream.mockResolvedValueOnce(new Response(null, { status: 400 })).mockResolvedValueOnce(Response.json(json));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    await expect(chatStream("parse", [], () => {}, { source: { feature: "简历导入解析" }, requireJson: true })).rejects.toMatchObject({ name: "LlmResponseError", code: "incomplete" });
    expect(upstream).toHaveBeenCalledTimes(useStream ? 1 : 2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "incomplete", usage: { inputTokens: 12, outputTokens: 5 } });
  });
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
