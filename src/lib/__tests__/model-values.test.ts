import { describe, expect, it } from "vitest";
import { normalizeReport, normalizeScores } from "../scores";
import { normalizeJargonDecoderResult, parseJargonDecoderResult } from "../jargon-decoder";
import { LlmResponseError, parseNonStreamReply } from "../llm-adapter";

describe("模型数值与 Responses 文本边界", () => {
  it.each([undefined, null, "", "  ", true, false, [], {}].map((value) => [value]))("拒绝非数值维度 %j", (value) => {
    const raw = { depth: value, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, strengths: "强项", weaknesses: "短板", suggestions: "建议" };
    expect(normalizeScores(raw)).toBeNull();
    expect(normalizeReport(raw)).toBeNull();
  });

  it.each([0, 8, "8", "8.5"])("保留合法分数 %j", (value) => {
    const raw = { depth: value, structure: 8, authenticity: 8, completeness: 8, jd_match: 8, strengths: "强项", weaknesses: "短板", suggestions: "建议" };
    expect(normalizeScores(raw)?.depth).toBe(Math.round(Number(value)));
    expect(normalizeReport(raw)?.depth).toBe(Number(value));
  });

  it.each([undefined, null, "", "  ", true, false, [], {}, -1, 101].map((value) => [value]))("黑话缺失或非法风险分数保留未评估 %j", (score) => {
    const result = normalizeJargonDecoderResult({
      items: [{ keyword: "抗压", hidden_meaning: "需进一步核实" }],
      overall_risk_score: score,
      risk_ratings: { overtime: score, stability: score, resources: score, management: score },
    });
    expect(result?.overallRiskScore).toBeNull();
    expect(result?.riskRatings).toEqual({ overtime: null, stability: null, resources: null, management: null });
    expect(parseJargonDecoderResult(JSON.stringify(result))?.overallRiskScore).toBeNull();
  });

  it("合法分数与未评估维度保持明确语义", () => {
    const stored = JSON.stringify({ items: [], overallRiskScore: 80, riskRatings: { overtime: 8 } });
    expect(parseJargonDecoderResult(stored)).toMatchObject({ overallRiskScore: 80, riskRatings: { overtime: 8, stability: null } });
    expect(normalizeJargonDecoderResult({ items: [{ keyword: "抗压" }], overall_risk_score: "75", risk_ratings: { overtime: "8" } }))
      .toMatchObject({ overallRiskScore: 75, riskRatings: { overtime: 8 } });
  });

  it("读取原始 Responses output_text 内容并忽略非文本片段", () => {
    expect(parseNonStreamReply("openai_responses", { output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "你" }, { type: "refusal", refusal: "no" }, { type: "output_text", text: "好" }] },
    ] })).toBe("你好");
  });

  it("Responses 支持代理 choices 与顶层 output_text", () => {
    expect(parseNonStreamReply("openai_responses", { choices: [{ message: { content: "ok" } }] })).toBe("ok");
    expect(parseNonStreamReply("openai_responses", { output_text: "ok" })).toBe("ok");
  });

  it("Responses 仅有拒绝片段时明确报缺失正文", () => {
    expect(() => parseNonStreamReply("openai_responses", { output: [{ content: [{ type: "refusal", refusal: "拒绝" }] }] })).toThrow(LlmResponseError);
    expect(() => parseNonStreamReply("openai_responses", { output: [{ content: [{ type: "refusal", refusal: "拒绝" }] }] })).toThrow("空正文");
  });

  it("支持传统 completion 的正式 text 输出", () => {
    expect(parseNonStreamReply("openai_chat", { choices: [{ text: "传统 completion 输出" }] })).toBe("传统 completion 输出");
  });

  it.each(["", null])("content 为 %j 时 reasoning_content 不能代替正文", (content) => {
    const json = { choices: [{ message: { content, reasoning_content: "思考中..." } }] };
    expect(() => parseNonStreamReply("openai_chat", json)).toThrow(LlmResponseError);
    expect(() => parseNonStreamReply("openai_chat", json)).toThrow("空正文");
  });

  it("Anthropic 只有 thinking 时不能代替正文", () => {
    const json = { content: [{ type: "thinking", thinking: "thinking content" }] };
    expect(() => parseNonStreamReply("anthropic_messages", json)).toThrow(LlmResponseError);
    expect(() => parseNonStreamReply("anthropic_messages", json)).toThrow("空正文");
  });

  it.each([undefined, null, "", " ", "critical", true, false, 1, {}, []].map((value) => [value]))("缺失或无效黑话条目等级为未评估：%j", (riskLevel) => {
    const normalized = normalizeJargonDecoderResult({ items: [{ keyword: "抗压", risk_level: riskLevel }] });
    expect(normalized?.items[0]!.riskLevel).toBeNull();
    expect(parseJargonDecoderResult(JSON.stringify(normalized))?.items[0]!.riskLevel).toBeNull();
    expect(parseJargonDecoderResult(JSON.stringify({ items: [{ keyword: "抗压", riskLevel }] }))?.items[0]!.riskLevel).toBeNull();
  });

  it.each(["low", "medium", "high"])("保留合法风险等级 %s", (riskLevel) => {
    const normalized = normalizeJargonDecoderResult({ items: [{ keyword: "抗压", risk_level: riskLevel }] });
    expect(normalized?.items[0]!.riskLevel).toBe(riskLevel);
    expect(parseJargonDecoderResult(JSON.stringify(normalized))?.items[0]!.riskLevel).toBe(riskLevel);
  });
});
