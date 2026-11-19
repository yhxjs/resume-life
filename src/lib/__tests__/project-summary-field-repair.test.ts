import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import {
  buildProjectSummaryFieldRepairSystems,
  PROJECT_SUMMARY_FIELD_REPAIR_ADDITION,
  PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR,
  projectSummaryFieldRepairCases,
} from "../../../evals/project-summary-field-repair-fixture";
import {
  PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE,
  PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES,
  PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE,
  PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES,
} from "../../../evals/project-summary-field-boundaries-fixture";

describe("联合字段修复候选的固定实验契约", () => {
  it("full candidate只组合两项字段说明和brief/作者规则，完全恢复生产提示", () => {
    const systems = buildProjectSummaryFieldRepairSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    const expectedCandidate = PROJECT_SUMMARY_SYSTEM_PROMPT
      .replace(PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE)
      .replace(PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES)
      .replace(PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR, PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR + PROJECT_SUMMARY_FIELD_REPAIR_ADDITION);
    expect(systems.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.candidate).toBe(expectedCandidate);
    expect(buildProjectSummaryFieldRepairSystems(systems.candidate)).toEqual(systems);
    expect(systems.baseline).not.toContain(PROJECT_SUMMARY_FIELD_REPAIR_ADDITION);
    expect(PROJECT_RESUME_SYSTEM_PROMPT).not.toContain(PROJECT_SUMMARY_FIELD_REPAIR_ADDITION);
    expect(() => buildProjectSummaryFieldRepairSystems(PROJECT_RESUME_SYSTEM_PROMPT)).toThrow();
  });

  it.each([
    ["architecture-only", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE,
    )],
    ["challenges-only", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES,
    )],
    ["addition-only", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR,
      PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR + PROJECT_SUMMARY_FIELD_REPAIR_ADDITION,
    )],
    ["duplicate-rule", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR,
      PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR + PROJECT_SUMMARY_FIELD_REPAIR_ADDITION + PROJECT_SUMMARY_FIELD_REPAIR_ADDITION,
    )],
    ["missing-rule-anchor", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_SUMMARY_FIELD_REPAIR_ANCHOR, "")],
  ] as const)("拒绝不完整或重复的候选种子：%s", (_name, prompt) => {
    expect(() => buildProjectSummaryFieldRepairSystems(prompt)).toThrow();
  });

  it("固定继承六份材料、12个配对ID与每臂24项模型准则/6项流程要求", () => {
    expect(projectSummaryFieldRepairCases).toHaveLength(6);
    expect(projectSummaryFieldRepairCases.map(sample => sample.id)).toEqual([
      "log-progress", "csv-unverified", "implemented-flow-current-role-not-authorship",
      "implemented-change-known-author", "observed-issue-without-cause-or-solution", "started-work-distinct-from-complete",
    ]);
    for (const sample of projectSummaryFieldRepairCases) {
      expect(sample.rubric).toHaveLength(5);
      expect(sample.rubric.slice(0, 4).every(item => !item.startsWith("审阅流程"))).toBe(true);
      expect(sample.rubric.at(-1)).toMatch(/^审阅流程（不计模型语义判据）：/);
    }
    expect(projectSummaryFieldRepairCases.reduce((sum, sample) => sum + sample.rubric.slice(0, -1).length, 0)).toBe(24);
    expect(projectSummaryFieldRepairCases.reduce((sum, sample) => sum + sample.rubric.slice(-1).length, 0)).toBe(6);
    const ids = projectSummaryFieldRepairCases.flatMap((sample, index) => {
      const arms = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      return arms.map(arm => sample.id + "/full/" + arm);
    });
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });
});
