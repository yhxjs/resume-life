import { describe, expect, it } from "vitest";

import { buildHeaders } from "../llm-adapter";

describe("LLM 请求头", () => {
  it("Anthropic 分支只用 x-api-key，不重复发 Authorization", () => {
    const headers = buildHeaders("anthropic_messages", "  sk-ant-test  ");

    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    // 同一把 Key 不得出现在两个请求头里：否则请求日志/代理日志会各记一份
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("authorization");
    expect(Object.values(headers).filter((value) => value.includes("sk-ant-test"))).toHaveLength(1);
  });

  it.each(["openai_chat", "openai_responses"] as const)("%s 分支只发 Authorization", (format) => {
    const headers = buildHeaders(format, "sk-openai-test");

    expect(headers["Authorization"]).toBe("Bearer sk-openai-test");
    expect(headers).not.toHaveProperty("x-api-key");
    expect(Object.values(headers).filter((value) => value.includes("sk-openai-test"))).toHaveLength(1);
  });
});
