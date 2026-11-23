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

import { chatStream, extractJson } from "../llm";

const SOURCE: LlmSource = { feature: "简历润色", entity: { type: "resume", id: 1 } };

/** 模拟上游 SSE；JSON 校验和客户端回调由真实 chatStream 执行。 */
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
  it("合法 JSON 但业务结构无效时复用同一重试预算，且只交付通过校验的结果", async () => {
    const invalid = '{"ok":false}';
    const valid = '{"ok":true}';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respondSse(invalid))
      .mockResolvedValueOnce(respondSse(valid));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    const validateOutput = vi.fn((content: string) => {
      if ((JSON.parse(content) as { ok?: unknown }).ok !== true) throw new Error("业务字段无效");
    });
    vi.useFakeTimers();
    const pending = chatStream("summary", [], onDelta, {
      source: SOURCE,
      requireJson: "strict",
      validateOutput,
      retryOutputValidationErrors: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBe(valid);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(validateOutput).toHaveBeenCalledTimes(2);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith(valid);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", attempts: 1 });
  });

  it("业务结构校验连续失败时最多请求三次，并抛出最后一次校验错误", async () => {
    const invalid = '{"ok":false}';
    const validationError = new Error("业务字段无效");
    const fetchMock = vi.fn(async () => respondSse(invalid));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const pending = chatStream("summary", [], onDelta, {
      source: SOURCE,
      requireJson: "strict",
      validateOutput: () => { throw validationError; },
      retryOutputValidationErrors: true,
    }).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBe(validationError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onDelta).not.toHaveBeenCalled();
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_output", attempts: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("业务结构校验默认不自动重试，保留调用方的显式重试流程", async () => {
    const invalid = '{"ok":false}';
    const validationError = new Error("业务字段无效");
    const fetchMock = vi.fn(async () => respondSse(invalid));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    const outcome = chatStream("summary", [], onDelta, {
      source: SOURCE,
      requireJson: "strict",
      validateOutput: () => { throw validationError; },
    }).then(() => null, (error: unknown) => error);

    expect(await outcome).toBe(validationError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onDelta).not.toHaveBeenCalled();
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_output", attempts: 0 });
  });

  it("结构校验器没有启用 JSON 缓冲时直接拒绝配置", async () => {
    const validateOutput = vi.fn();
    await expect(chatStream("summary", [], undefined, { validateOutput })).rejects.toThrow("requireJson");
    expect(validateOutput).not.toHaveBeenCalled();
  });

  it.each([true, "strict"] as const)("%s 拒绝重复字段后按原预算重试，只交付唯一字段的结果", async requireJson => {
    const bad = '{"depth":2,"depth":9,"comment":"SYNTHETIC_PRIVATE_MARKER"}';
    const good = '{"depth":7,"comment":"有效点评"}';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respondSse(bad, { prompt: 10, completion: 5 }))
      .mockResolvedValueOnce(respondSse(good, { prompt: 20, completion: 10 }));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const pending = chatStream("summary", [], onDelta, { source: SOURCE, requireJson });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(good);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith(good);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", attempts: 1,
      usage: { inputTokens: 30, outputTokens: 15 } });
  });

  it.each([true, "strict"] as const)("%s 重复字段耗尽重试后失败，不外发正文或字段名", async requireJson => {
    const bad = '{"evaluation":{"SYNTHETIC_PRIVATE_MARKER":1,"SYNTHETIC_PRIVATE_MARKER":2}}';
    vi.stubGlobal("fetch", vi.fn(async () => respondSse(bad, { prompt: 7, completion: 3 })));
    const onDelta = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.useFakeTimers();
    const outcome = chatStream("summary", [], onDelta, { source: SOURCE, requireJson })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const failure = await outcome as Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("不是有效 JSON");
    expect(failure.stack).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(failure.cause).toBeUndefined();
    expect(onDelta).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_json", attempts: 2,
      usage: { inputTokens: 21, outputTokens: 9 } });
    expect(JSON.stringify(recorded.calls)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(JSON.stringify(info.mock.calls)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, "strict"] as const)("%s 保留合法 JSON 字符串内的围栏字面量，不误判为坏 JSON 重试", async requireJson => {
    const raw = JSON.stringify({ text: "解析 ```json bad-json ``` 是技术说明，不是外层 JSON。" });
    const fetchMock = vi.fn(async () => respondSse(raw));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const pending = chatStream("summary", [], onDelta, { source: SOURCE, requireJson })
      .then(value => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ value: raw });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith(raw);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", attempts: 0 });
  });

  it.each(([true, "strict"] as const).flatMap(requireJson => [false, true].map(fallback => ({ requireJson, fallback }))))(
    "$requireJson / fallback=$fallback：耗尽重试的错误不附带模型正文，保留用量与错误分类", async ({ requireJson, fallback }) => {
      const raw = '{"SYNTHETIC_PRIVATE_MARKER":敏感原文，仍未输出有效 JSON}';
      const fetchMock = vi.fn(async () => fallback
        ? Response.json({ choices: [{ message: { content: raw } }], usage: { prompt_tokens: 7, completion_tokens: 3 } })
        : respondSse(raw, { prompt: 7, completion: 3 }));
      if (fallback) fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const onDelta = vi.fn();
      vi.useFakeTimers();
      const outcome = chatStream("summary", [], onDelta, { source: SOURCE, requireJson })
        .then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const failure = await outcome as Error;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("不是有效 JSON");
      expect(failure.message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(failure.stack).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(failure.cause).toBeUndefined();
      expect(onDelta).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(fallback ? 4 : 3);
      expect(recorded.calls).toHaveLength(1);
      expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_json", attempts: 2,
        usage: { inputTokens: 21, outputTokens: 9 } });
      expect(JSON.stringify(recorded.calls)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(JSON.stringify(info.mock.calls)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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

  it.each(['```json\n{"a":1}\n```', '说明：{"a":1}，结束'])("容错模式继续接受可提取的 JSON：%s", async (raw) => {
    const fetchMock = vi.fn().mockResolvedValue(respondSse(raw));
    vi.stubGlobal("fetch", fetchMock);

    expect(await chatStream("summary", [], undefined, { source: SOURCE, requireJson: true })).toContain('{"a":1}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", attempts: 0 });
  });

  it.each([
    '```json\n{"a":1}\n```',
    '说明：{"a":1}，结束',
    '{"a":1}\n{"extra":',
  ])("严格模式重试非纯 JSON，不把包装文字或截断尾部发给客户端：%s", async (raw) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respondSse(raw, { prompt: 10, completion: 5 }))
      .mockResolvedValueOnce(respondSse(' {"a":1} \n', { prompt: 20, completion: 10 }));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const run = chatStream("summary", [], onDelta, { source: SOURCE, requireJson: "strict" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run).toBe('{"a":1}');
    expect(onDelta.mock.calls).toEqual([['{"a":1}']]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({
      status: "ok", attempts: 1, usage: { inputTokens: 30, outputTokens: 15 },
    });
  });

  it("严格模式持续收到围栏 JSON 时耗尽重试，零外发并记录失败", async () => {
    const fetchMock = vi.fn(async () => respondSse('```json\n{"a":1}\n```'));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const run = chatStream("summary", [], onDelta, { source: SOURCE, requireJson: "strict" });
    const rejection = expect(run).rejects.toThrow("不是有效 JSON");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onDelta).not.toHaveBeenCalled();
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_json", attempts: 2 });
  });

  it("严格语法错误与网络错误共享原有重试上限", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockImplementation(async () => respondSse('```json\n{"a":1}\n```'));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const run = chatStream("summary", [], undefined, { source: SOURCE, requireJson: "strict" });
    const rejection = expect(run).rejects.toThrow("不是有效 JSON");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_json", attempts: 2 });
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

  it("有客户端回调时同样重试无效 JSON，只发送成功尝试的完整内容", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respondSse("not json", { prompt: 7, completion: 3 }))
      .mockResolvedValueOnce(respondSse('{"ok":true}', { prompt: 10, completion: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    vi.useFakeTimers();
    const run = chatStream("summary", [], (delta) => deltas.push(delta), { source: SOURCE, requireJson: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run).toBe('{"ok":true}');
    expect(deltas).toEqual(['{"ok":true}']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]).toMatchObject({
      status: "ok", attempts: 1, usage: { inputTokens: 17, outputTokens: 8 },
    });
  });

  it("有客户端回调时耗尽 JSON 重试也不发送坏片段", async () => {
    const fetchMock = vi.fn(async () => respondSse("not json"));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const run = chatStream("summary", [], onDelta, { source: SOURCE, requireJson: true });
    const rejection = expect(run).rejects.toThrow("不是有效 JSON");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(onDelta).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "invalid_json", attempts: 2 });
  });

  it.each([true, "strict"] as const)("网关拒绝流式后，非流式回退仍按 %s 校验且只发送成功结果", async (requireJson) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("stream unsupported", { status: 400 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: requireJson === "strict" ? '```json\n{"ok":true}\n```' : "not json" } }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const run = chatStream("summary", [], onDelta, { source: SOURCE, requireJson });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await run).toBe('{"ok":true}');
    expect(onDelta.mock.calls).toEqual([['{"ok":true}']]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).stream)).toEqual([true, undefined, undefined]);
    expect(recorded.calls[0]).toMatchObject({ status: "ok", attempts: 1 });
  });

  it("上游缺少完成事件时安全重试，成功前不发送缓存 JSON", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"{\\\"ok\\\":true}"}}]}\n\n';
    const fetchMock = vi.fn(async () => new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    vi.useFakeTimers();
    const run = chatStream("summary", [], onDelta, { source: SOURCE, requireJson: "strict" });
    const rejection = expect(run).rejects.toMatchObject({ code: "protocol", reason: "interrupted" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(onDelta).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recorded.calls[0]).toMatchObject({ status: "failed", errorCode: "protocol", attempts: 2 });
  });

  it.each([false, true, "strict"] as const)("requireJson=%s 时按约定发送已收到但尚未完成的内容", async (requireJson) => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; },
      pull() { pulls += 1; },
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    const encoder = new TextEncoder();
    const onDelta = vi.fn();
    const run = chatStream("summary", [], onDelta, { source: SOURCE, requireJson });
    // 先发送部分 JSON，等待消费者再次读取，确认这一帧已被处理。
    await vi.waitFor(() => expect(pulls).toBe(1));
    upstream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\\"ok\\\":"}}]}\n\n'));
    // 再次拉取说明上一帧已消费，避免只凭计时推断回调时机。
    await vi.waitFor(() => expect(pulls).toBeGreaterThanOrEqual(2));
    if (requireJson) expect(onDelta).not.toHaveBeenCalled();
    else expect(onDelta).toHaveBeenCalledWith('{"ok":');
    upstream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"true}"}}]}\n\ndata: [DONE]\n\n'));
    upstream.close();
    expect(await run).toBe('{"ok":true}');
    expect(onDelta.mock.calls.map(([delta]) => delta)).toEqual(requireJson ? ['{"ok":true}'] : ['{"ok":', 'true}']);
  });

  it.each([true, "strict"] as const)("%s JSON 缓存期间取消，不发送已有片段、不重试", async (requireJson) => {
    const controller = new AbortController();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { upstream = value; },
      pull() { pulls += 1; },
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    const run = chatStream("summary", [], onDelta, { source: SOURCE, requireJson, signal: controller.signal });
    const rejection = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(pulls).toBe(1));
    upstream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"{\\\"ok\\\":true}"}}]}\n\n'));
    await vi.waitFor(() => expect(pulls).toBeGreaterThanOrEqual(2));
    controller.abort();
    // 真实 fetch 在取消时也会终止 body；此处让模拟的 body 读取结束。
    upstream.close();
    expect(onDelta).not.toHaveBeenCalled();
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(recorded.calls[0]).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });
});

describe("extractJson 的错误信息与合法正文兼容", () => {
  it.each([
    '{"depth":2,"depth":9}',
    '{"depth":2,"\\u0064epth":9}',
    '```json\n{"depth":2,"depth":9}\n```',
    '说明：{"depth":2,"depth":9}。',
    '说明：```json\n{"depth":2,"depth":9}\n```。',
    '{"text":"```json {} ```","depth":2,"depth":9}',
    '```json\n{"text":"```json {} ```","depth":2,"depth":9}\n```',
    '[{"evaluation":{"score":1,"score":2}}]',
    '说明：{"text":"```json {} ```","depth":2,"depth":9}。',
    '说明：{"text":"```json {} ```","depth":2,"depth":9}。附录 {}',
    '{"depth":2,"depth":9}。```json {} ```',
    '说明：```json\n{"text":"```json {} ```","depth":2,"depth":9}\n```。',
    '说明 [] 表示空数组；结果 {"text":"```json {} ```","depth":2,"depth":9}。',
  ])("拒绝重复字段，不通过抽取内部围栏绕过：%s", raw => {
    expect(() => extractJson(raw)).toThrow("不是有效 JSON");
  });

  it.each([
    { text: "解析 ```json null ``` 报文" },
    { text: "示例 ```json {} ``` 与 ```json [] ``` 都是字符串内容" },
    [{ text: "代码片段 ```json true ```" }],
    "原文 ```json 42 ```，保留字符串类型",
    { nested: { text: "保留 ```json bad-json ```、换行\n反斜杠\\及引号\"" } },
  ].flatMap(value => [false, true].map(fenced => ({ value, fenced }))))(
    "完整 JSON 优先于字符串中的围栏，外层有围栏=$fenced（%#）", ({ value, fenced }) => {
      const json = JSON.stringify(value);
      const raw = fenced ? ["\n```json", json, "```\n"].join("\n") : ` \n${json}\t `;
      expect(extractJson(raw)).toEqual(value);
    },
  );

  it.each([
    "SYNTHETIC_PRIVATE_MARKER：没有 JSON",
    '{"SYNTHETIC_PRIVATE_MARKER":bad-json}',
    '前文 {"SYNTHETIC_PRIVATE_MARKER":bad-json} 后文',
    '```json\n{"SYNTHETIC_PRIVATE_MARKER":bad-json}\n```',
    '["SYNTHETIC_PRIVATE_MARKER",bad-json]',
    '{"SYNTHETIC_PRIVATE_MARKER":',
  ])("无法解析时不将原文或 JSON.parse 异常附加到错误：%s", raw => {
    const failure = (() => { try { return extractJson(raw); } catch (error) { return error; } })() as Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("不是有效 JSON");
    expect(failure.message).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(failure.stack).not.toContain("SYNTHETIC_PRIVATE_MARKER");
    expect(failure.cause).toBeUndefined();
  });

  it.each(["", " \n\t"])("空内容 %j 仍报 JSON 无效", raw => {
    expect(() => extractJson(raw)).toThrow("不是有效 JSON");
  });

  it.each([
    [' {"text":"SYNTHETIC_PRIVATE_MARKER"} ', { text: "SYNTHETIC_PRIVATE_MARKER" }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['说明：```json\n{"a":1}\n```。', { a: 1 }],
    ['```json\n{"a":1}\n```\n补充：```json\n{"a":2}\n```', { a: 1 }],
    ['说明：{"a":1}。', { a: 1 }],
    ['说明：[1,2]。', [1, 2]],
    ['说明：{"text":"```json {} ```","depth":2}。', { text: "```json {} ```", depth: 2 }],
    ['说明：[{"text":"```json {} ```","depth":2}]。附录 {}', [{ text: "```json {} ```", depth: 2 }]],
    ['说明：```json\n{"text":"```json {} ```","depth":2}\n```。', { text: "```json {} ```", depth: 2 }],
    ['说明中的 {} 表示对象。以下是结果：```json\n{"a":1}\n```', { a: 1 }],
    ['空字段用 [] 表示。结果：```json\n{"a":1}\n```', { a: 1 }],
    ['说明 []、{} 表示空值。结果 {"text":"```json {} ```","depth":2}。', { text: "```json {} ```", depth: 2 }],
    ['null', null],
    ['true', true],
    ['3', 3],
    ['"SYNTHETIC_PRIVATE_MARKER"', "SYNTHETIC_PRIVATE_MARKER"],
  ])("合法正文 %s 保留原值", (raw, expected) => {
    expect(extractJson(raw as string)).toEqual(expected);
  });
});
