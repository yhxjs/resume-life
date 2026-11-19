import { describe, expect, it } from "vitest";
import { PROJECT_REPO_SCAN_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_ARCHIVE_CONFLICT_V7_RULE, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import { isGeneratedProjectSummary, PROJECT_SUMMARY_OUTPUT_LIMITS as LIMITS, validateGeneratedProjectResume } from "../summary";

describe("项目总结提示词按输出模式限定规则", () => {
  it("仅完整总结包含五维字段长度与职责分析规则", () => {
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain("用于深度面试准备");
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain(`每项硬上限 ${LIMITS.dimension} 字`);
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).not.toContain("通常 80-180 字");
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain('"responsibilities"');
    expect(PROJECT_RESUME_SYSTEM_PROMPT).not.toContain("五维字段");
    expect(PROJECT_RESUME_SYSTEM_PROMPT).not.toContain('"responsibilities"');
    expect(PROJECT_RESUME_SYSTEM_PROMPT).not.toContain("分析字段");
  });

  it("各生成入口共享标题和整体状态，成果保留局部限定而不逐条复述背景", () => {
    for (const prompt of [PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_REPO_SCAN_SYSTEM_PROMPT]) {
      expect(prompt).toContain("achievements 不逐条重复项目名");
      expect(prompt).toContain("项目整体发布状态只在 brief 说明一次");
      expect(prompt).toContain("以具体功能或机制作主语，不制造个人归功");
      expect(prompt).toContain("局部组件或任务的未上线／未验证状态");
      expect(prompt).toContain("CHANGELOG 某一版本的“未发布”标题，都不能单独证明整个项目尚未发布");
      expect(prompt).not.toContain("逐项假设其他字段不可见");
      expect(prompt).not.toContain("每条都要说明该工具未发布");
    }
  });

  it("深度分析展开机制与 STAR 证据，简历精炼入口不套用深度写法", () => {
    for (const prompt of [PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_REPO_SCAN_SYSTEM_PROMPT]) {
      expect(prompt).toContain("challenges 按 STAR 组织");
      expect(prompt).toContain("不为凑字数扩写");
      expect(prompt).toContain("五维分析可在 JSON 字符串内用转义换行分段");
    }
    expect(PROJECT_RESUME_SYSTEM_PROMPT).not.toContain("展开要求：overview");
  });

  it("两种模式都保留三项简历字段的字数及证据约束", () => {
    for (const prompt of [PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT]) {
      expect(prompt).toContain(`techStack ${LIMITS.techStack} 字，brief ${LIMITS.brief} 字`);
      expect(prompt).toContain(`achievements 每项 ${LIMITS.achievement} 字`);
      expect(prompt).toContain(`所有输出文本合计不超过 ${LIMITS.totalText} 字`);
      expect(prompt).toContain("不自动把旧成果作为本次可靠成果保留");
    }
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain("只在直接相关的一个五维字段说明待核实");
    expect(PROJECT_RESUME_SYSTEM_PROMPT).toContain("在 techStack、brief 和 achievements 中省略或弱化有争议的说法");
  });

  it("完整总结将已验证的档案冲突规则放在输出契约之后", () => {
    const outputEnd = PROJECT_SUMMARY_SYSTEM_PROMPT.indexOf("不编造内容绕过校验。");
    const conflictRule = PROJECT_SUMMARY_SYSTEM_PROMPT.indexOf(PROJECT_SUMMARY_ARCHIVE_CONFLICT_V7_RULE);
    const sourceRules = PROJECT_SUMMARY_SYSTEM_PROMPT.indexOf("目标与来源：");
    expect(outputEnd).toBeGreaterThanOrEqual(0);
    expect(conflictRule).toBeGreaterThan(outputEnd);
    expect(sourceRules).toBeGreaterThan(conflictRule);
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT.indexOf(PROJECT_SUMMARY_ARCHIVE_CONFLICT_V7_RULE, conflictRule + 1)).toBe(-1);
  });

  it("两个模式的 JSON 示例都不预填成果条目", () => {
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain('"achievements": []');
    expect(PROJECT_RESUME_SYSTEM_PROMPT).toContain('"achievements": []');
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).not.toContain('"achievements": ["一个有依据的技术动作与可核对结果"]');
    expect(PROJECT_RESUME_SYSTEM_PROMPT).not.toContain('"achievements": ["一个有依据的技术动作与可核对结果"]');
  });

  it("明确成果数组允许为空，但不允许空白条目", () => {
    for (const prompt of [PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT]) {
      expect(prompt).toContain("achievements 为字符串数组，每项是非空字符串；没有可靠成果时允许空数组 []");
    }
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain("七个文本字段均为字符串，信息不足时用空字符串");
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).not.toContain("未知用空字符串");
  });

  it("新生成校验允许空字段但拒绝不可见占位", () => {
    const complete = {
      overview: "", architecture: "", highlights: "", responsibilities: "", challenges: "",
      techStack: "TypeScript", brief: "项目介绍", achievements: [],
    };
    expect(isGeneratedProjectSummary(complete)).toBe(true);
    expect(isGeneratedProjectSummary({ ...complete, overview: "\u200b" })).toBe(false);
    expect(validateGeneratedProjectResume({ techStack: "\u2060", brief: "", achievements: [] })).toBeNull();
    expect(validateGeneratedProjectResume({ techStack: "", brief: "", achievements: [] })).toEqual({ techStack: "", brief: "", achievements: [] });
  });

  it("完整空结构表示无有效总结，调用方拒绝草稿并给出明确反馈", () => {
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain("返回完整空结构表示“无有效总结”");
    expect(PROJECT_SUMMARY_SYSTEM_PROMPT).toContain("明确报告没有可靠内容并拒绝草稿");
    expect(PROJECT_RESUME_SYSTEM_PROMPT).not.toContain("完整空结构表示“无有效总结”");
  });
});
