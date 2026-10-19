import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE,
  handleSsePayload,
  mergeUsage,
  parseNonStreamUsage,
} from "../llm-adapter";

function sse(format: Parameters<typeof handleSsePayload>[0], payload: unknown) {
  const usage: Partial<typeof EMPTY_USAGE>[] = [];
  const done = handleSsePayload(format, JSON.stringify(payload), () => {}, (u) => usage.push(u));
  return { done, usage };
}

describe("parseNonStreamUsage", () => {
  it("openai_chat：input 为 prompt_tokens，cached 取自 prompt_tokens_details", () => {
    expect(parseNonStreamUsage("openai_chat", {
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } },
    })).toEqual({ inputTokens: 1000, outputTokens: 200, cachedTokens: 400 });
  });

  it("openai_chat：网关不返回 details 时 cached 为 null 而非 0", () => {
    expect(parseNonStreamUsage("openai_chat", {
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    })).toEqual({ inputTokens: 1000, outputTokens: 200, cachedTokens: null });
  });

  it("anthropic：input 含缓存读写，cached 为 cache_read_input_tokens", () => {
    expect(parseNonStreamUsage("anthropic_messages", {
      usage: { input_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 200, output_tokens: 300 },
    })).toEqual({ inputTokens: 800, outputTokens: 300, cachedTokens: 500 });
  });

  it("openai_responses：取 input_tokens / output_tokens / input_tokens_details", () => {
    expect(parseNonStreamUsage("openai_responses", {
      usage: { input_tokens: 900, output_tokens: 150, input_tokens_details: { cached_tokens: 300 } },
    })).toEqual({ inputTokens: 900, outputTokens: 150, cachedTokens: 300 });
  });

  it("完全没有 usage 字段时三个值都是 null", () => {
    expect(parseNonStreamUsage("openai_chat", {})).toEqual(EMPTY_USAGE);
    expect(parseNonStreamUsage("openai_responses", {})).toEqual(EMPTY_USAGE);
  });

  it("归一化不变量：cached 永远不超过 input", () => {
    const openai = parseNonStreamUsage("openai_chat", {
      usage: { prompt_tokens: 1000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 400 } },
    });
    const anthropic = parseNonStreamUsage("anthropic_messages", {
      usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 1 },
    });
    for (const usage of [openai, anthropic]) {
      if (usage.cachedTokens !== null && usage.inputTokens !== null) {
        expect(usage.cachedTokens).toBeLessThanOrEqual(usage.inputTokens);
      }
    }
  });
});

describe("handleSsePayload 的 usage 回调", () => {
  it("anthropic：message_start 给输入与缓存，message_delta 给输出", () => {
    const start = sse("anthropic_messages", {
      type: "message_start",
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 1 } },
    });
    expect(start.usage).toEqual([{ inputTokens: 600, cachedTokens: 500, outputTokens: 1 }]);

    const delta = sse("anthropic_messages", { type: "message_delta", usage: { output_tokens: 300 } });
    expect(delta.usage).toEqual([{ outputTokens: 300 }]);

    let merged = mergeUsage(EMPTY_USAGE, start.usage[0]!);
    merged = mergeUsage(merged, delta.usage[0]!);
    expect(merged).toEqual({ inputTokens: 600, outputTokens: 300, cachedTokens: 500 });
  });

  it("openai_chat：末块带 usage（choices 为空）时回调，且不产生 delta", () => {
    const deltas: string[] = [];
    const usage: Partial<typeof EMPTY_USAGE>[] = [];
    handleSsePayload("openai_chat", JSON.stringify({
      choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
    }), (d) => deltas.push(d), (u) => usage.push(u));

    expect(deltas).toEqual([]);
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 2, cachedTokens: 4 }]);
  });

  it("openai_responses：response.completed 同时给出终态与 usage", () => {
    const result = sse("openai_responses", {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 900, output_tokens: 150, input_tokens_details: { cached_tokens: 300 } } },
    });
    expect(result.done).toBe("done");
    expect(result.usage).toEqual([{ inputTokens: 900, outputTokens: 150, cachedTokens: 300 }]);
  });
});
