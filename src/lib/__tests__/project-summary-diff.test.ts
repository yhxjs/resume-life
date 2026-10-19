import { describe, expect, it } from "vitest";
import { adoptSummaryChanges, compareProjectSummaries } from "../project-summary-diff";
import { emptySummary } from "../summary";

describe("project summary incremental comparison", () => {
  it("classifies new, changed, and corrected conflicts without labeling unknown baselines as conflicts", () => {
    const current = {
      ...emptySummary(),
      overview: "我校正的项目定位",
      architecture: "旧架构",
      highlights: "保持原样",
      achievements: ["我校正的成果", "旧成果"],
    };
    const generated = {
      ...current,
      overview: "AI 新项目定位",
      architecture: "新架构",
      techStack: "React",
      achievements: ["AI 新成果", "旧成果", "新增成果"],
    };
    const changes = compareProjectSummaries(current, generated, {
      overview: "AI 旧项目定位",
      architecture: "旧架构",
      "achievement:0": "AI 旧成果",
    });

    expect(changes.map(({ key, status }) => [key, status])).toEqual([
      ["overview", "conflict"],
      ["architecture", "changed"],
      ["techStack", "new"],
      ["achievement:0", "conflict"],
      ["achievement:2", "new"],
    ]);
    expect(compareProjectSummaries(current, generated, {})[0]?.status).toBe("changed");
  });

  it("adopts only selected units, preserves corrected wording, and tracks AI origins after achievement removal", () => {
    const current = {
      ...emptySummary(),
      overview: "用户校正表达",
      architecture: "旧架构",
      achievements: ["保留成果", "删除成果", "后续成果"],
    };
    const generated = {
      ...current,
      overview: "AI 新表达",
      architecture: "新架构",
      achievements: ["替换成果"],
    };
    const result = adoptSummaryChanges(
      current,
      generated,
      { overview: "AI 旧表达", architecture: "旧架构", "achievement:0": "保留成果", "achievement:1": "删除成果", "achievement:2": "后续成果" },
      ["architecture", "achievement:1"],
    );

    expect(result.summary).toMatchObject({ overview: "用户校正表达", architecture: "新架构" });
    expect(result.summary.achievements).toEqual(["保留成果", "后续成果"]);
    expect(result.aiBaseline).toMatchObject({ overview: "AI 旧表达", architecture: "新架构", "achievement:0": "保留成果", "achievement:1": "后续成果" });
    expect(result.aiBaseline).not.toHaveProperty("achievement:2");
  });
});
