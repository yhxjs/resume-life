import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import {
  buildProjectSummaryFieldBoundariesSystems,
  PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE,
  PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE,
  PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES,
  PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES,
  projectSummaryFieldBoundariesCases,
} from "../../../evals/project-summary-field-boundaries-fixture";
import { projectChallengeAdmissionCases } from "../../../evals/project-challenge-admission-fixture";
import { projectChallengeBoundaryCases } from "../../../evals/project-challenge-boundaries-fixture";
import { projectPersonalScopeCases } from "../../../evals/project-personal-scope-fixture";
import { projectWorkStateCases } from "../../../evals/project-work-state-fixture";

describe("完整总结架构与难点联合候选的固定实验契约", () => {
  it("候选只替换两个完整字段说明，恢复后逐字等于生产提示", () => {
    const systems = buildProjectSummaryFieldBoundariesSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.candidate).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT
      .replace(PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE)
      .replace(PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES));
    expect(buildProjectSummaryFieldBoundariesSystems(systems.candidate)).toEqual(systems);
    expect(() => buildProjectSummaryFieldBoundariesSystems(PROJECT_RESUME_SYSTEM_PROMPT)).toThrow();
  });

  it.each([
    ["architecture-only", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_ARCHITECTURE,
    )],
    ["challenges-only", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES, PROJECT_SUMMARY_FIELD_BOUNDARIES_CANDIDATE_CHALLENGES,
    )],
    ["missing-architecture", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_ARCHITECTURE, "")],
    ["duplicate-challenges", PROJECT_SUMMARY_SYSTEM_PROMPT + PROJECT_SUMMARY_FIELD_BOUNDARIES_BASELINE_CHALLENGES],
    ["unknown-description", PROJECT_SUMMARY_SYSTEM_PROMPT.replace("实际模块、数据流与协作机制", "项目相关信息")],
  ] as const)("拒绝不完整或未知的提示种子：%s", (_name, prompt) => {
    expect(() => buildProjectSummaryFieldBoundariesSystems(prompt)).toThrow();
  });

  it("原样继承六份预定材料且分别覆盖六种边界", () => {
    const inherited = [
      projectChallengeBoundaryCases.find(sample => sample.id === "log-progress")!,
      projectChallengeBoundaryCases.find(sample => sample.id === "csv-unverified")!,
      projectWorkStateCases.find(sample => sample.id === "implemented-flow-current-role-not-authorship")!,
      projectPersonalScopeCases.find(sample => sample.id === "implemented-change-known-author")!,
      projectChallengeAdmissionCases.find(sample => sample.id === "observed-issue-without-cause-or-solution")!,
      projectWorkStateCases.find(sample => sample.id === "started-work-distinct-from-complete")!,
    ];
    expect(projectSummaryFieldBoundariesCases).toHaveLength(6);
    inherited.forEach((sample, index) => {
      const current = projectSummaryFieldBoundariesCases[index]!;
      expect({ id: current.id, projectName: current.projectName, source: current.source })
        .toEqual({ id: sample.id, projectName: sample.projectName, source: sample.source });
      expect(current.rubric).toHaveLength(5);
      expect(current.rubric.at(-1)).toMatch(/^审阅流程（不计模型语义判据）：/);
      expect(current.rubric.slice(0, 4).every(item => !item.startsWith("审阅流程"))).toBe(true);
    });
  });

  it("固定12个唯一配对ID、每臂24项模型判据及6项流程要求", () => {
    const ids = projectSummaryFieldBoundariesCases.flatMap((sample, caseIndex) => {
      const arms = caseIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      return arms.map(arm => sample.id + "/full/" + arm);
    });
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    const modelCriteriaPerArm = projectSummaryFieldBoundariesCases.reduce((sum, sample) => sum + sample.rubric.slice(0, -1).length, 0);
    const processCriteriaPerArm = projectSummaryFieldBoundariesCases.reduce((sum, sample) => sum + sample.rubric.slice(-1).length, 0);
    expect(modelCriteriaPerArm).toBe(24);
    expect(modelCriteriaPerArm * 2).toBe(48);
    expect(processCriteriaPerArm).toBe(6);
    expect(processCriteriaPerArm * 2).toBe(12);
    expect(projectSummaryFieldBoundariesCases.map(sample => sample.id)).toEqual([
      "log-progress", "csv-unverified", "implemented-flow-current-role-not-authorship",
      "implemented-change-known-author", "observed-issue-without-cause-or-solution", "started-work-distinct-from-complete",
    ]);
  });
});
