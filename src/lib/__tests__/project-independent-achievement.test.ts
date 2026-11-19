import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import {
  buildProjectIndependentAchievementSystems,
  PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION,
  PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR,
  projectIndependentAchievementCases,
} from "../../../evals/project-independent-achievement-fixture";
import { projectChallengeAdmissionCases } from "../../../evals/project-challenge-admission-fixture";
import { projectChallengeBoundaryCases } from "../../../evals/project-challenge-boundaries-fixture";
import { projectPersonalScopeCases } from "../../../evals/project-personal-scope-fixture";
import { projectWorkStateCases } from "../../../evals/project-work-state-fixture";

describe("独立成果条目候选的固定实验契约", () => {
  it("只在full输出合同旁插入一句，移除后逐字等于生产提示", () => {
    const systems = buildProjectIndependentAchievementSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.candidate).toContain(PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR + PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION);
    expect(systems.candidate.replace(
      PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR + PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION,
      PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR,
    )).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(buildProjectIndependentAchievementSystems(systems.candidate)).toEqual(systems);
    expect(() => buildProjectIndependentAchievementSystems(PROJECT_RESUME_SYSTEM_PROMPT)).toThrow();
  });

  it.each([
    ["missing-anchor", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR, "")],
    ["duplicate-anchor", PROJECT_SUMMARY_SYSTEM_PROMPT + PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR],
    ["orphan-addition", PROJECT_SUMMARY_SYSTEM_PROMPT + PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION],
    ["duplicate-addition", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR,
      PROJECT_INDEPENDENT_ACHIEVEMENT_ANCHOR + PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION + PROJECT_INDEPENDENT_ACHIEVEMENT_ADDITION,
    )],
    ["unknown-output-contract", PROJECT_SUMMARY_SYSTEM_PROMPT.replace("achievements 为字符串数组", "成果为自由文本")],
  ] as const)("拒绝无法唯一恢复的提示：%s", (_name, prompt) => {
    expect(() => buildProjectIndependentAchievementSystems(prompt)).toThrow();
  });

  it("原样继承六份来源并覆盖归属已知/未知、实现状态和本地验证范围", () => {
    const inherited = [
      projectChallengeBoundaryCases.find(sample => sample.id === "csv-unverified")!,
      projectPersonalScopeCases.find(sample => sample.id === "implemented-change-known-author")!,
      projectPersonalScopeCases.find(sample => sample.id === "implemented-change-unknown-author")!,
      projectWorkStateCases.find(sample => sample.id === "implemented-flow-current-role-not-authorship")!,
      projectChallengeAdmissionCases.find(sample => sample.id === "observed-issue-without-cause-or-solution")!,
      projectWorkStateCases.find(sample => sample.id === "started-work-distinct-from-complete")!,
    ];
    expect(projectIndependentAchievementCases).toHaveLength(6);
    inherited.forEach((sample, index) => {
      const current = projectIndependentAchievementCases[index]!;
      expect({ id: current.id, projectName: current.projectName, source: current.source })
        .toEqual({ id: sample.id, projectName: sample.projectName, source: sample.source });
      expect(current.rubric).toHaveLength(5);
      expect(current.rubric.at(-1)).toMatch(/^审阅流程（不计模型语义判据）：/);
      expect(current.rubric.slice(0, 4).every(item => !item.startsWith("审阅流程"))).toBe(true);
    });
  });

  it("固定12个唯一ID、24项模型判据和6项流程要求，并交替两臂次序", () => {
    const ids = projectIndependentAchievementCases.flatMap((sample, caseIndex) => {
      const arms = caseIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      return arms.map(arm => sample.id + "/full/" + arm);
    });
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(projectIndependentAchievementCases.reduce((sum, sample) => sum + sample.rubric.slice(0, -1).length, 0) * 2).toBe(48);
    expect(projectIndependentAchievementCases.reduce((sum, sample) => sum + sample.rubric.slice(-1).length, 0) * 2).toBe(12);
    expect(projectIndependentAchievementCases.map(sample => sample.id)).toEqual([
      "csv-unverified", "implemented-change-known-author", "implemented-change-unknown-author",
      "implemented-flow-current-role-not-authorship", "observed-issue-without-cause-or-solution",
      "started-work-distinct-from-complete",
    ]);
  });
});
