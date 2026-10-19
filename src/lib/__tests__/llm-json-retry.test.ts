import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmSource } from "../llm-source";

const settings = vi.hoisted(() => ({
  base_url: "https://model.invalid/v1",
  api_key: "synthetic",
  model_parse: "fake",
  model_summary: "fake",
  api_format: "openai_chat",
}));
const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("../settings", () => ({ readSettings: () => settings }));
vi.mock("../llm-call-log", () => ({
  recordLlmCall: (record: Record<string, unknown>) => { recorded.calls.push(record); },
}));

import { chatStream } from "../llm";

const SOURCE: LlmSource = { feature: "简历润色", entity: { type: "resume", id: 1 } };

/** chatStream 默认走流式传输；未传 onDelta 时不影响 requireJson 的重试判定（tokenSent 仅由 onDelta 置位） */
function respondSse(text: string, usage?: { prompt: number; completion: number }) {
  const chunks = [
    { choices: [{ delta: { content: text } }] },
    ...(usage ? [{ choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion } }] : []),
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

beforeEach(() => {
  recorded.calls.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requireJson 无效 JSON 自动重试", () => {
  it("首次无效 JSON 后重试成功：只写一条 ok 日志，attempts 与 token 跨尝试累计", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respondSse("抱歉，我无法输出", { prompt: 10, completion: 5 }))
      .mockResolvedValueOnce(respondSse('{"ok":true}', { prompt: 20, completion: 10 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const run = chatStream("summary", [], undefined, { source: SOURCE, requireJson: true, requestId: "retry-request" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await run).toBe('{"ok":true}');
    } finally {
      vi.useRealTimers();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retry = info.mock.calls.map(([line]) => JSON.parse(String(line).replace(/^\[server-info\]\s*/, "")))
      .filter((entry) => entry.operation === "llm.request");
    expect(retry.length).toBeGreaterThan(0);
    expect(retry.every((entry) => entry.requestId === "retry-request")).toBe(true);
    expect(JSON.stringify(retry)).not.toContain("抱歉，我无法输出");
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({
      status: "ok", errorCode: "", attempts: 1,
      usage: { inputTokens: 30, outputTokens: 15 },
    });
  });

  it("容忍围栏与前后杂文：extractJson 可解析的内容不触发重试", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respondSse('```json\n{"a":1}\n```'));
    vi.stubGlobal("fetch", fetchMock);

    expect(await chatStream("summary", [], undefined, { source: SOURCE, requireJson: true })).toContain('{"a":1}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", attempts: 0 });
  });

  it("三次都无效时耗尽重试：抛错并写 failed 日志（invalid_json，attempts=2）", async () => {
    // 每次调用都返回新 Response：Response body 只能读一次，重试拿到同一个会报流已锁定
    const fetchMock = vi.fn(async () => respondSse("not json at all", { prompt: 7, completion: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const run = chatStream("summary", [], undefined, { source: SOURCE, requireJson: true }).then(() => null, (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await run as Error).message).toContain("不是有效 JSON");
    } finally {
      vi.useRealTimers();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 次初始 + 2 次重试 = 共 3 次尝试
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({
      status: "failed", errorCode: "invalid_json", attempts: 2,
      usage: { inputTokens: 21, outputTokens: 9 },
    });
  });

  it("未开启 requireJson 时不校验也不重试", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respondSse("plain text, not json"));
    vi.stubGlobal("fetch", fetchMock);

    expect(await chatStream("summary", [], undefined, { source: SOURCE })).toBe("plain text, not json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", attempts: 0 });
  });

  it("流式已向客户端输出内容后不做 JSON 重试，直接原样抛错", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respondSse("not json"));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    await expect(
      chatStream("summary", [], (delta) => deltas.push(delta), { source: SOURCE, requireJson: true })
    ).rejects.toThrow("不是有效 JSON");
    expect(deltas).toEqual(["not json"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_json", attempts: 0 });
  });
});
