import { describe, expect, it } from "vitest";
import {
  emptySummary,
  isStoredProjectSummary,
  isGeneratedProjectSummary,
  normalizeSummary,
  parseSummary,
  ProjectSummaryCorruptError,
} from "../summary";

describe("ProjectSummary 数据模型与工具方法", () => {
  it("emptySummary 返回包含全部 8 个字段的空默认对象", () => {
    const s = emptySummary();
    expect(s.overview).toBe("");
    expect(s.architecture).toBe("");
    expect(s.highlights).toBe("");
    expect(s.responsibilities).toBe("");
    expect(s.challenges).toBe("");
    expect(s.techStack).toBe("");
    expect(s.brief).toBe("");
    expect(s.achievements).toEqual([]);
  });

  it("完整总结可校验并原样读取，未生成时返回空总结", () => {
    const summary = {
      overview: "项目背景",
      architecture: "微服务架构",
      highlights: "高可用设计",
      responsibilities: "核心研发",
      challenges: "突破并发瓶颈",
      techStack: "React, Next.js, TypeScript",
      brief: "企业级高并发系统",
      achievements: ["优化长列表加载延迟 50%", "主导架构演进"],
    };
    expect(isStoredProjectSummary(summary)).toBe(true);
    expect(parseSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseSummary("{}")).toEqual(emptySummary());
  });

  it("isStoredProjectSummary 对非法结构或错误类型返回 false", () => {
    expect(isStoredProjectSummary(null)).toBe(false);
    expect(isStoredProjectSummary("string")).toBe(false);
    expect(isStoredProjectSummary({ unknownField: "val" })).toBe(false);
    expect(isStoredProjectSummary({ techStack: 123 })).toBe(false);
    expect(isStoredProjectSummary({ achievements: "not-an-array" })).toBe(false);
    expect(isStoredProjectSummary({ achievements: [1, 2, 3] })).toBe(false);
  });

  it("parseSummary 在 JSON 损坏或结构不合法时抛出 ProjectSummaryCorruptError", () => {
    expect(() => parseSummary("invalid-json{")).toThrow(ProjectSummaryCorruptError);
    expect(() => parseSummary(JSON.stringify({ malicious: 1 }))).toThrow(ProjectSummaryCorruptError);
  });

  it("normalizeSummary 正确清理非标准类型与数组字段", () => {
    const dirty = {
      overview: "有效概述",
      techStack: "React, Node.js",
      brief: "简述",
      achievements: [" 成果 1 ", "成果 2", "", 123],
      extra: "discarded",
    };
    const clean = normalizeSummary(dirty);
    expect(clean.overview).toBe("有效概述");
    expect(clean.techStack).toBe("React, Node.js");
    expect(clean.brief).toBe("简述");
    expect(clean.achievements).toEqual(["成果 1", "成果 2"]);
    expect((clean as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it("isGeneratedProjectSummary 正确识别有效生成结果", () => {
    expect(isGeneratedProjectSummary({ overview: "有内容" })).toBe(true);
    expect(isGeneratedProjectSummary({ techStack: "React" })).toBe(true);
    expect(isGeneratedProjectSummary({ achievements: ["优化性能"] })).toBe(true);
    expect(isGeneratedProjectSummary({ overview: "  ", techStack: "" })).toBe(false);
    expect(isGeneratedProjectSummary({})).toBe(false);
  });
});
