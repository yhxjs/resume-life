import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STYLE } from "../templates";

const { safeChat } = vi.hoisted(() => ({ safeChat: vi.fn() }));

vi.mock("@/lib/safe-llm", () => ({
  safeChat,
  LLM_FEATURES: { styleGenerate: "样式 AI 调优" },
}));

import { POST } from "@/app/api/styles/generate/route";

function request(prompt = "测试风格") {
  return new Request("http://localhost/api/styles/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

describe("AI 样式生成接口", () => {
  beforeEach(() => safeChat.mockReset());

  it("不把蓝色默认值写进模型提示词，避免模型照抄默认样式", async () => {
    safeChat.mockResolvedValue(JSON.stringify({ ...DEFAULT_STYLE, accent: "#7c3aed" }));

    const response = await POST(request());

    expect(response.status).toBe(200);
    const systemPrompt = safeChat.mock.calls[0]?.[2] as string;
    expect(systemPrompt).not.toContain("#2563eb");
    expect(systemPrompt).not.toContain('"headerBg": "#');
  });

  it.each([
    ["空对象", "{}"],
    ["缺少字段", JSON.stringify({ ...DEFAULT_STYLE, accent: undefined })],
    ["非法颜色", JSON.stringify({ ...DEFAULT_STYLE, accent: "blue" })],
    ["越界数值", JSON.stringify({ ...DEFAULT_STYLE, pageMargin: 99 })],
  ])("模型返回%s时拒绝静默回退默认值", async (_label, raw) => {
    safeChat.mockResolvedValue(raw);

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("AI 生成的样式参数异常");
  });

  it("完整且合法的样式参数仍能正常返回", async () => {
    safeChat.mockResolvedValue(JSON.stringify({ ...DEFAULT_STYLE, accent: "#7c3aed" }));

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect((await response.json()).style).toMatchObject({ accent: "#7c3aed" });
  });

  it("完整但完全等于默认样式时拒绝静默回退", async () => {
    safeChat.mockResolvedValue(JSON.stringify(DEFAULT_STYLE));

    const response = await POST(request());

    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("没有生成有效的个性化样式");
  });
});
