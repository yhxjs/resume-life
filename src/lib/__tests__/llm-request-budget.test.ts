import { describe, expect, it } from "vitest";
import { buildRequestBody } from "../llm-adapter";

describe("协议输出额度", () => {
  const base = { model: "synthetic", messages: [{ role: "user" as const, content: "合成输入" }] };
  it.each([false, true])("Anthropic stream=%s 的缺省请求包含必填额度", (stream) => {
    const body = buildRequestBody({ ...base, format: "anthropic_messages", stream });
    expect(body.max_tokens).toBe(4096);
    expect(buildRequestBody({ ...base, format: "anthropic_messages", stream, maxTokens: 8192 }).max_tokens).toBe(8192);
  });
  it.each(["openai_chat", "openai_responses"] as const)("%s 保留未指定额度的协议行为", (format) => {
    const body = buildRequestBody({ ...base, format, stream: false });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_output_tokens");
  });
  it("openai_chat 显式传入额度时注入 max_tokens", () => {
    const body = buildRequestBody({ ...base, format: "openai_chat", stream: false, maxTokens: 8192 });
    expect(body.max_tokens).toBe(8192);
  });
  it("openai_responses 显式传入额度时注入 max_output_tokens", () => {
    const body = buildRequestBody({ ...base, format: "openai_responses", stream: false, maxTokens: 8192 });
    expect(body.max_output_tokens).toBe(8192);
  });
});
