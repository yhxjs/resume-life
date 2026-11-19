import { describe, expect, it } from "vitest";
import {
  emptySummary,
  isEmptyGeneratedProjectSummary,
  isStoredProjectSummary,
  isGeneratedProjectSummary,
  getGeneratedProjectSummaryError,
  normalizeSummary,
  parseSummary,
  PROJECT_SUMMARY_OUTPUT_LIMITS,
  ProjectSummaryCorruptError,
  validateGeneratedProjectResume,
} from "../summary";

describe("ProjectSummary 数据模型与工具方法", () => {
  it.each([
    { output: [], reason: "顶层必须是 JSON 对象" },
    { output: { overview: "概述" }, reason: "缺少字段：architecture、highlights、responsibilities、challenges、techStack、brief、achievements" },
    { output: { ...emptySummary(), PRIVATE_EXTRA_KEY: "私人原文" }, reason: "包含 1 个额外字段" },
    { output: { ...emptySummary(), responsibilities: null }, reason: "responsibilities 必须是字符串" },
    { output: { ...emptySummary(), architecture: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension + 1) }, reason: `architecture 长度 ${PROJECT_SUMMARY_OUTPUT_LIMITS.dimension + 1}，超过 ${PROJECT_SUMMARY_OUTPUT_LIMITS.dimension} 字上限` },
    { output: { ...emptySummary(), techStack: "字".repeat(201) }, reason: "techStack 长度 201，超过 200 字上限" },
    { output: { ...emptySummary(), brief: "字".repeat(201) }, reason: "brief 长度 201，超过 200 字上限" },
    { output: { ...emptySummary(), achievements: ["字".repeat(301)] }, reason: "achievements 第 1 条 长度 301，超过 300 字上限" },
    { output: { ...emptySummary(), achievements: ["私人原文", "  私人原文\n"] }, reason: "achievements 第 2 条 与第 1 条重复" },
    { output: { ...emptySummary(), achievements: [false] }, reason: "achievements 第 1 条 必须是字符串" },
  ])("无效生成结果显示具体校验原因而不回显原文：$reason", ({ output, reason }) => {
    const message = getGeneratedProjectSummaryError(output);
    expect(message).toContain(reason);
    expect(message).not.toContain("私人原文");
    expect(message).not.toContain("PRIVATE_EXTRA_KEY");
    expect(isGeneratedProjectSummary(output)).toBe(false);
  });

  it("有效稀疏总结不返回校验错误", () => {
    expect(getGeneratedProjectSummaryError({ ...emptySummary(), overview: "有依据的项目定位" })).toBeNull();
  });

  it("深度面试分析支持展开段落，简历成果仍保持原来的单项上限", () => {
    const detailed = { ...emptySummary(), architecture: "有依据的数据流与模块协作。\n".repeat(45), challenges: "本地问题复现、处理机制与验证范围。\n".repeat(30) };
    expect(detailed.architecture.length).toBeGreaterThan(300);
    expect(isGeneratedProjectSummary(detailed)).toBe(true);
    expect(isGeneratedProjectSummary({ ...detailed, achievements: ["字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.achievement + 1)] })).toBe(false);
  });

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
    expect(isGeneratedProjectSummary({ ...emptySummary(), overview: "有内容" })).toBe(true);
    expect(isGeneratedProjectSummary({ ...emptySummary(), techStack: "React" })).toBe(true);
    expect(isGeneratedProjectSummary({ ...emptySummary(), achievements: ["优化性能"] })).toBe(true);
    expect(isGeneratedProjectSummary({ ...emptySummary(), overview: "  " })).toBe(false);
    expect(isGeneratedProjectSummary(emptySummary())).toBe(false);
    expect(isGeneratedProjectSummary({})).toBe(false);
  });

  it.each([
    ["完全相同", "使用 TypeScript 校验接口"],
    ["仅首尾空白", "  使用 TypeScript 校验接口 \n"],
    ["仅全半角", "使用 ＴｙｐｅＳｃｒｉｐｔ 校验接口"],
    ["仅大小写", "使用 typescript 校验接口"],
    ["仅连续空白", "使用 \t TypeScript \n 校验接口"],
  ])("新生成两种总结都拒绝%s的成果，历史读取仍完整保留", (_label, duplicate) => {
    const summary = { ...emptySummary(), achievements: ["使用 TypeScript 校验接口", duplicate] };
    expect(isGeneratedProjectSummary(summary)).toBe(false);
    expect(validateGeneratedProjectResume({ techStack: "", brief: "", achievements: summary.achievements })).toBeNull();
    expect(parseSummary(JSON.stringify(summary))).toEqual(summary);
    expect(normalizeSummary(summary).achievements).toHaveLength(2);
  });

  it("成果比较保留任务、版本、环境和技术符号的差异，不改写原文", () => {
    const achievements = [
      "A 任务 v1 测试环境使用 TypeScript 校验接口", "A 任务 v2 测试环境使用 TypeScript 校验接口",
      "B 任务 v1 测试环境使用 TypeScript 校验接口", "A 任务 v1 离线环境使用 TypeScript 校验接口",
      "学习 C++", "学习 C#", "支持 operator<", "支持 operator>",
    ];
    expect(isGeneratedProjectSummary({ ...emptySummary(), achievements })).toBe(true);
    expect(validateGeneratedProjectResume({ techStack: "", brief: "", achievements })?.achievements).toEqual(achievements);
  });

  it("生成结果拒绝提示词未要求的额外字段", () => {
    expect(isGeneratedProjectSummary({ ...emptySummary(), overview: "有内容", debug: "额外字段" })).toBe(false);
    expect(isGeneratedProjectSummary({ ...emptySummary(), overview: "有内容", source: "extra" })).toBe(false);
    expect(validateGeneratedProjectResume({ techStack: "TS", brief: "项目介绍", achievements: [], overview: "多余字段" })).toBeNull();
  });

  it.each(Object.keys(emptySummary()))("生成结果不能省略或返回错误类型的 %s", (key) => {
    const complete: Record<string, unknown> = { ...emptySummary(), overview: "有效概述" };
    const incomplete = { ...complete };
    delete incomplete[key];
    expect(isGeneratedProjectSummary(incomplete)).toBe(false);
    expect(isGeneratedProjectSummary({ ...complete, [key]: null })).toBe(false);
    expect(isGeneratedProjectSummary({ ...complete, [key]: false })).toBe(false);
  });

  it.each(["旧式成果文本", ["有效成果", false], ["有效成果", " "], [null]])("不丢弃错误成果后放行：%j", (achievements) => {
    expect(isGeneratedProjectSummary({ ...emptySummary(), overview: "有效概述", achievements })).toBe(false);
  });

  it("新生成总结拒绝超出字段或成果数量上限，但历史存档仍可读取", () => {
    const longOverview = { ...emptySummary(), overview: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension + 1) };
    const tooManyAchievements = {
      ...emptySummary(),
      achievements: Array.from({ length: PROJECT_SUMMARY_OUTPUT_LIMITS.maxAchievements + 1 }, (_, index) => `成果${index + 1}`),
    };
    expect(isGeneratedProjectSummary(longOverview)).toBe(false);
    expect(isGeneratedProjectSummary(tooManyAchievements)).toBe(false);
    expect(isGeneratedProjectSummary({ ...emptySummary(), brief: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.brief + 1) })).toBe(false);
    expect(isGeneratedProjectSummary({ ...emptySummary(), achievements: ["字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.achievement + 1)] })).toBe(false);
    expect(parseSummary(JSON.stringify(longOverview))).toEqual(longOverview);
  });

  it("完整总结允许达到合计上限，超过一个字符即拒绝", () => {
    const atLimit = {
      overview: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension),
      architecture: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension),
      highlights: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension),
      responsibilities: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension),
      challenges: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.dimension),
      techStack: "技".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.techStack),
      brief: "简".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.brief),
      achievements: [
        ...Array.from({ length: 8 }, (_, index) => `${index}${"成".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.achievement - 1)}`),
        "成".repeat(200),
      ],
    };
    expect(isGeneratedProjectSummary(atLimit)).toBe(true);
    expect(isGeneratedProjectSummary({ ...atLimit, achievements: [...atLimit.achievements.slice(0, -1), `${atLimit.achievements.at(-1)}成`] })).toBe(false);
  });

  it("只把完整且全空的八字段对象识别为无有效总结信号", () => {
    expect(isEmptyGeneratedProjectSummary(emptySummary())).toBe(true);
    expect(isEmptyGeneratedProjectSummary({ ...emptySummary(), overview: "有依据的内容" })).toBe(false);
    expect(isEmptyGeneratedProjectSummary({ ...emptySummary(), debug: "额外字段" })).toBe(false);
    expect(isEmptyGeneratedProjectSummary({ ...emptySummary(), achievements: [" "] })).toBe(false);
  });

  it("简历三要素沿用同一字段与成果上限", () => {
    expect(validateGeneratedProjectResume({
      techStack: "字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.techStack + 1), brief: "简介", achievements: [],
    })).toBeNull();
    expect(validateGeneratedProjectResume({
      techStack: "TS", brief: "简介", achievements: Array.from({ length: PROJECT_SUMMARY_OUTPUT_LIMITS.maxAchievements + 1 }, () => "成果"),
    })).toBeNull();
    expect(validateGeneratedProjectResume({
      techStack: "TS", brief: "简介", achievements: ["字".repeat(PROJECT_SUMMARY_OUTPUT_LIMITS.achievement + 1)],
    })).toBeNull();
  });
});
