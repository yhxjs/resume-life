import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../settings", () => ({ API_KEY_MASK_PREFIX: "masked_", readSettings: () => ({ base_url: "https://model.invalid/v1", api_key: "synthetic", model_parse: "fake", api_format: "openai_responses" }) }));
import { POST } from "../../app/api/settings/test/route";
afterEach(() => vi.unstubAllGlobals());

describe("模型设置连通测试", () => {
  it.each([{}, { output_text: "   " }, { output: [] }])("空模型文本不能成功：%j", async (output) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(output)));
    const res = await POST(new Request("http://localhost/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(await res.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("原始 Responses 文本可以通过测试", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })));
    const res = await POST(new Request("http://localhost/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
    expect(await res.json()).toEqual({ ok: true, reply: "ok" });
  });

  it("当 content 为空但有 reasoning_content 时拒绝缺失正文", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: "思考中..." } }],
    })));
    const res = await POST(new Request("http://localhost/api/settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_format: "openai_chat" }),
    }));
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ ok: false, error: expect.stringContaining("空正文") });
    expect(data.error).not.toContain("思考中...");
  });

  it.each(["", '{"result":"partial but valid JSON"}'])("达到输出上限时拒绝正文：%s", async (content) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      choices: [{ message: { role: "assistant", content }, finish_reason: "length" }],
    })));
    const res = await POST(new Request("http://localhost/api/settings/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_format: "openai_chat" }),
    }));
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(data.ok).toBe(false);
    expect(data.error).toContain("响应未完成：已达到输出上限，可前往「设置」调大最大输出 token 限制后重试");
    expect(data.error).toContain("LlmResponseError");
  });
});
