import { afterEach, expect, it, vi } from "vitest";

vi.mock("../settings", () => ({ readSettings: () => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_chat" }) }));
import { chat, chatStream } from "../llm";
import type { ChatMessage } from "../llm-adapter";
import { checkModelInput, MAX_MODEL_IMAGE_BYTES } from "../llm-input-budget";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([chat, (task: Parameters<typeof chat>[0], messages: Parameters<typeof chat>[1]) => chatStream(task, messages)])("rejects total system and user input over 64000 characters before fetch", async (call) => {
  const fetch = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(call("parse", [{ role: "system", content: "s".repeat(4000) }, { role: "user", content: "字".repeat(60001) }])).rejects.toThrow(/64000/);
  expect(fetch).not.toHaveBeenCalled();
});

it("allows the exact total input boundary without truncating", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const messages = [{ role: "system" as const, content: "s".repeat(4000) }, { role: "user" as const, content: "字".repeat(60000) }];
  expect(await chat("parse", messages)).toBe("ok");
  expect(JSON.parse(fetch.mock.calls[0]![1].body).messages).toEqual(messages);
});

function imageMessage(...sizes: number[]): ChatMessage {
  return { role: "user", content: sizes.map((bytes) => ({
    type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.alloc(bytes).toString("base64")}` },
  })) };
}

it("allows multiple images whose combined size exceeds the per-image limit", () => {
  const messages = [imageMessage(3 * 1024 * 1024, 3 * 1024 * 1024)];
  expect(checkModelInput(messages)).toBe(messages);
});

it("allows the exact per-image and total limits across messages", () => {
  const messages = [imageMessage(MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGE_BYTES), imageMessage(MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGE_BYTES)];
  expect(checkModelInput(messages)).toBe(messages);
});

it("rejects an individually oversized image before calling the model", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(chat("parse", [imageMessage(MAX_MODEL_IMAGE_BYTES + 1)])).rejects.toThrow(/单张视觉模型图片/);
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects total image bytes over the limit even when each image is allowed", () => {
  const messages = [imageMessage(MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGE_BYTES), imageMessage(MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGE_BYTES, 1)];
  expect(() => checkModelInput(messages)).toThrow(/图片总大小/);
});

it("rejects more than five images across messages", () => {
  expect(() => checkModelInput([imageMessage(1, 1, 1), imageMessage(1, 1, 1)])).toThrow(/最多包含 5 张/);
});
