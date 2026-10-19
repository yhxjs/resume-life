import { describe, expect, it } from "vitest";

describe("AI 生成输出结构校验", () => {
  it("拒绝缺失字段的离职空窗方案", async () => {
    const { validateGeneratedRemedyResult } = await import("../career-gap-remedy");
    expect(validateGeneratedRemedyResult({})).toBeNull();
  });

  it("拒绝缺失嵌套字段的薪酬开局", async () => {
    const { validateGeneratedNegotiationOpening } = await import("../salary-negotiation");
    expect(validateGeneratedNegotiationOpening({})).toBeNull();
  });

  it("拒绝缺失嵌套字段的薪酬回合", async () => {
    const { validateGeneratedNegotiationTurn } = await import("../salary-negotiation");
    expect(validateGeneratedNegotiationTurn({ hr_response: "回复" })).toBeNull();
  });

  it("拒绝只有摘要的薪酬复盘报告", async () => {
    const { validateGeneratedNegotiationReport } = await import("../salary-negotiation");
    expect(validateGeneratedNegotiationReport({ final_package_summary: "30k", mentor_summary: "完成" })).toBeNull();
  });
});
