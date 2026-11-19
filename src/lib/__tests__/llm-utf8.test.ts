import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiFormat } from "../settings-constants";

const settings = vi.hoisted(() => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }));
const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../llm-call-log", () => ({ recordLlmCall: (entry: Record<string, unknown>) => recorded.calls.push(entry) }));

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-llm-utf8-"));
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
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("resume-life-llm-utf8-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(root, { recursive: true, force: true });
});

const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const fixtures: { format: ApiFormat; delta: (text: string) => string; done: string; json: (text: string) => unknown }[] = [
  { format: "openai_chat", delta: text => event({ choices: [{ delta: { content: text } }] }), done: "data: [DONE]\n\n",
    json: text => ({ choices: [{ message: { content: text } }] }) },
  { format: "anthropic_messages", delta: text => event({ type: "content_block_delta", delta: { type: "text_delta", text } }), done: event({ type: "message_stop" }),
    json: text => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) },
  { format: "openai_responses", delta: text => event({ type: "response.output_text.delta", delta: text }), done: event({ type: "response.completed", response: { status: "completed" } }),
    json: text => ({ status: "completed", output_text: text }) },
];

function byteResponse(bytes: Uint8Array, cancel = vi.fn()) {
  return new Response(new ReadableStream({
    start(controller) {
      // 单字节网络块同时覆盖多字节字符与错误序列跨块的边界。
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
    cancel,
  }));
}

describe.each(fixtures)("$format UTF-8 字节边界", ({ format, delta, done, json }) => {
  it.each([
    [0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf4, 0x90, 0x80, 0x80],
  ].flatMap(bytes => ([false, true] as const).map(fallback => ({ bytes, fallback }))))(
    "坏编码 $bytes / fallback=$fallback 不替换后当作有效 JSON，不重试或外发", async ({ bytes, fallback }) => {
      settings.api_format = format;
      const content = '{"result":"SYNTHETIC_PRIVATE_MARKER"}';
      const wire = fallback ? JSON.stringify(json(content)) : delta(content) + done;
      const token = Buffer.from("SYNTHETIC_PRIVATE_MARKER");
      const encoded = Buffer.from(wire);
      const position = encoded.indexOf(token);
      expect(position).toBeGreaterThan(0);
      const corrupted = Buffer.concat([encoded.subarray(0, position), Buffer.from(bytes), encoded.subarray(position + token.length)]);
      const upstream = vi.fn(async () => byteResponse(corrupted));
      if (fallback) upstream.mockResolvedValueOnce(new Response(null, { status: 400 }));
      vi.stubGlobal("fetch", upstream);
      const { chatStream } = await import("../llm");
      vi.useFakeTimers();
      const onDelta = vi.fn();
      const outcome = chatStream("parse", [], onDelta, { source: { feature: "简历导入解析" }, requireJson: "strict" })
        .then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4000);
      const failure = await outcome;
      expect(failure).toMatchObject({ name: "LlmResponseError", code: "protocol", message: expect.stringContaining("UTF-8") });
      expect((failure as Error).cause).toBeUndefined();
      expect(onDelta).not.toHaveBeenCalled();
      expect(upstream).toHaveBeenCalledTimes(fallback ? 2 : 1);
      expect(recorded.calls).toHaveLength(1);
      expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "protocol", attempts: 0 });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("EOF 时尚未完成的字符不能在尾注释里被替换或忽略", async () => {
    settings.api_format = format;
    const wire = Buffer.concat([Buffer.from(delta('{"ok":true}') + ": SYNTHETIC_PRIVATE_MARKER "), Buffer.from([0xe2, 0x82])]);
    vi.stubGlobal("fetch", vi.fn(async () => byteResponse(wire)));
    const { chatStream } = await import("../llm");
    const onDelta = vi.fn();
    await expect(chatStream("parse", [], onDelta, { requireJson: "strict" }))
      .rejects.toMatchObject({ code: "protocol", message: expect.stringContaining("UTF-8") });
    expect(onDelta).not.toHaveBeenCalled();
  });

  it.each([false, true])("fallback=%s：BOM、跨字节中英文及实际替换字符完整往返", async fallback => {
    settings.api_format = format;
    const content = '{"result":"中英文 A𠮷😀 与合法替换字符 �，未上线。"}';
    const wire = Buffer.from("\uFEFF" + (fallback ? JSON.stringify(json(content)) : delta(content) + done));
    const upstream = vi.fn(async () => byteResponse(wire));
    if (fallback) upstream.mockResolvedValueOnce(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", upstream);
    const { chatStream } = await import("../llm");
    const onDelta = vi.fn();
    expect(await chatStream("parse", [], onDelta, { requireJson: "strict" })).toBe(content);
    expect(onDelta.mock.calls).toEqual([[content]]);
    expect(upstream).toHaveBeenCalledTimes(fallback ? 2 : 1);
  });
});
