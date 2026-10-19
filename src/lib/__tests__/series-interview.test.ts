import { describe, it, expect } from "vitest";
import {
  SERIES_ROUNDS,
  SERIES_ROUND_DEFS,
  seriesRoundOf,
  normalizeSeriesReport,
} from "../series";
import {
  INTERVIEW_STYLES,
  getInterviewStyle,
  interviewStyleOf,
} from "../interview";

describe("series.ts 进阶多轮面试业务逻辑", () => {
  it("进阶面试固定为 3 轮，且每一轮的顺序、风格与人设完全对齐", () => {
    expect(SERIES_ROUNDS).toBe(3);
    expect(SERIES_ROUND_DEFS).toHaveLength(3);

    const round1 = seriesRoundOf(1);
    expect(round1?.style).toBe("deep");
    expect(round1?.label).toContain("技术面");

    const round2 = seriesRoundOf(2);
    expect(round2?.style).toBe("manager");
    expect(round2?.label).toContain("主管面");

    const round3 = seriesRoundOf(3);
    expect(round3?.style).toBe("hr");
    expect(round3?.label).toContain("HR 面");

    expect(seriesRoundOf(0)).toBeUndefined();
    expect(seriesRoundOf(4)).toBeUndefined();
  });

  it("normalizeSeriesReport 正确规范化跨轮综合报告", () => {
    const raw = {
      overall: 8.64,
      verdict: "通过 (Strong Hire)",
      strengths: "基础扎实，技术深度与主管面表现卓越",
      weaknesses: "HR 沟通方面薪酬预期需进一步核实",
      suggestions: "可直接安排发 Offer 流程",
    };

    const report = normalizeSeriesReport(raw);
    expect(report).not.toBeNull();
    expect(report?.overall).toBe(8.6); // 四舍五入保留 1 位小数
    expect(report?.verdict).toBe("通过 (Strong Hire)");
    expect(report?.strengths).toBe(raw.strengths);
  });

  it("normalizeSeriesReport 严格校验非法或残缺报告", () => {
    expect(normalizeSeriesReport(null)).toBeNull();
    expect(normalizeSeriesReport({})).toBeNull();
    // 分数超范围 (0-10)
    expect(normalizeSeriesReport({ overall: 11, verdict: "通过" })).toBeNull();
    expect(normalizeSeriesReport({ overall: -1, verdict: "通过" })).toBeNull();
    // 缺少必要 verdict 结论
    expect(normalizeSeriesReport({ overall: 8.0, verdict: "" })).toBeNull();
    expect(normalizeSeriesReport({ overall: 8.0 })).toBeNull();
  });
});

describe("interview.ts 面试官人格与风格体系", () => {
  it("包含 5 大预设面试官风格", () => {
    const styleKeys = INTERVIEW_STYLES.map((s) => s.key);
    expect(styleKeys).toContain("gentle");
    expect(styleKeys).toContain("stress");
    expect(styleKeys).toContain("deep");
    expect(styleKeys).toContain("manager");
    expect(styleKeys).toContain("hr");
  });

  it("getInterviewStyle 与 interviewStyleOf 遇到未知风格优雅回退至 gentle", () => {
    expect(getInterviewStyle("deep")).toBe("deep");
    expect(getInterviewStyle("unknown_style")).toBe("gentle");
    expect(getInterviewStyle(null)).toBe("gentle");

    const deepStyle = interviewStyleOf("deep");
    expect(deepStyle.label).toBe("技术深挖");
    expect(deepStyle.persona).toContain("技术专家");

    const fallbackStyle = interviewStyleOf("non_existent");
    expect(fallbackStyle.key).toBe("gentle");
  });
});
