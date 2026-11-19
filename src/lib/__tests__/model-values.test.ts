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
    const stored = JSON.stringify({ ...normalizeJargonDecoderResult({ items: [{ keyword: "抗压" }] }), items: [], overallRiskScore: 80, riskRatings: { overtime: 8 } });
    expect(parseJargonDecoderResult(stored)).toMatchObject({ overallRiskScore: 80, riskRatings: { overtime: 8, stability: null } });
    expect(normalizeJargonDecoderResult({ items: [{ keyword: "抗压" }], overall_risk_score: "75", risk_ratings: { overtime: "8" } }))
      .toMatchObject({ overallRiskScore: 75, riskRatings: { overtime: 8 } });
  });

  it("保留明确说明未发现风险线索的空报告，并能从存储结果回读", () => {
    const result = normalizeJargonDecoderResult({
      target_summary: "职责与要求清晰的岗位说明",
      punchline: "目前没有明确风险线索，仍需核实实际工作安排。",
      overall_risk_score: 1,
      risk_ratings: { overtime: 1, stability: 1, resources: 1, management: 1 },
      items: [],
      company_profile: { team_style: "信息不足", risk_flags: [], culture_summary: "文本没有相关线索，不代表已经证实安全。" },
      golden_questions: ["能否介绍最近一个项目的排期与分工？"],
    });
    expect(result).toMatchObject({ items: [], overallRiskScore: 1, companyProfile: { riskFlags: [] } });
    expect(parseJargonDecoderResult(JSON.stringify(result))).toEqual(result);
  });

  it.each([{}, { items: [] }, { items: [{ keyword: "" }] }])("不把残缺输出误判成无风险报告：%j", (raw) => {
    expect(normalizeJargonDecoderResult(raw)).toBeNull();
  });

  it("即使摘要完整，也不把被过滤掉的无效条目判为主动返回空结果", () => {
    expect(normalizeJargonDecoderResult({
      target_summary: "岗位说明", punchline: "需核实", overall_risk_score: 1,
      risk_ratings: { overtime: 1, stability: 1, resources: 1, management: 1 },
      company_profile: { culture_summary: "信息不足" },
      items: [{ keyword: "" }],
    })).toBeNull();
  });

  it("Responses 正文和明确拒绝片段混合时仍报告拒绝", () => {
    expect(() => parseNonStreamReply("openai_responses", { output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "你" }, { type: "refusal", refusal: "no" }, { type: "output_text", text: "好" }] },
    ] })).toThrow(expect.objectContaining({ code: "incomplete", message: expect.stringContaining("拒绝") }));
  });

  it("Responses 支持代理 choices 与顶层 output_text", () => {
    expect(parseNonStreamReply("openai_responses", { choices: [{ message: { content: "ok" } }] })).toBe("ok");
    expect(parseNonStreamReply("openai_responses", { output_text: "ok" })).toBe("ok");
  });

  it("Responses 仅有拒绝片段时明确报拒绝", () => {
    expect(() => parseNonStreamReply("openai_responses", { output: [{ content: [{ type: "refusal", refusal: "拒绝" }] }] })).toThrow(LlmResponseError);
    expect(() => parseNonStreamReply("openai_responses", { output: [{ content: [{ type: "refusal", refusal: "拒绝" }] }] })).toThrow("拒绝");
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
    expect(parseJargonDecoderResult(JSON.stringify({ ...normalized, items: [{ ...normalized!.items[0], riskLevel }] }))?.items[0]!.riskLevel).toBeNull();
  });

  it.each(["low", "medium", "high"])("保留合法风险等级 %s", (riskLevel) => {
    const normalized = normalizeJargonDecoderResult({ items: [{ keyword: "抗压", risk_level: riskLevel }] });
    expect(normalized?.items[0]!.riskLevel).toBe(riskLevel);
    expect(parseJargonDecoderResult(JSON.stringify(normalized))?.items[0]!.riskLevel).toBe(riskLevel);
  });
});
