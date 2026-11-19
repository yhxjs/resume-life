import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import {
  buildProjectArchitectureEvidenceSystems,
  PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE,
  PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE,
  projectArchitectureEvidenceCases,
} from "../../../evals/project-architecture-evidence-fixture";
import { projectChallengeAdmissionCases } from "../../../evals/project-challenge-admission-fixture";
import { projectChallengeBoundaryCases } from "../../../evals/project-challenge-boundaries-fixture";
import { projectPersonalScopeCases } from "../../../evals/project-personal-scope-fixture";
import { projectWorkStateCases } from "../../../evals/project-work-state-fixture";

describe("项目架构证据候选的固定实验契约", () => {
  it("只替换full示例中的一个architecture值，恢复后逐字等于生产提示", () => {
    const systems = buildProjectArchitectureEvidenceSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.baseline).toContain(PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE);
    expect(systems.candidate).toContain(PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE);
    expect(systems.candidate.replace(PROJECT_ARCHITECTURE_EVIDENCE_CANDIDATE_LINE, PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE))
      .toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(buildProjectArchitectureEvidenceSystems(systems.candidate)).toEqual(systems);
    expect(() => buildProjectArchitectureEvidenceSystems(PROJECT_RESUME_SYSTEM_PROMPT)).toThrow();
  });

  it.each([
    ["missing-field", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE, "")],
    ["duplicate-field", PROJECT_SUMMARY_SYSTEM_PROMPT + "\n" + PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE],
    ["unknown-field-value", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_ARCHITECTURE_EVIDENCE_BASELINE_LINE, '  "architecture": "未知说明",')],
    ["previous-candidate-in-dimension-rules", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      "architecture 只写有依据的模块、数据流或协作机制",
      "architecture只写有明确实现证据的模块",
    )],
    ["previous-candidate-appended", PROJECT_SUMMARY_SYSTEM_PROMPT + "\n职责分工和计划本身不证明架构"],
  ] as const)("拒绝无法唯一恢复的提示：%s", (_name, prompt) => {
    expect(() => buildProjectArchitectureEvidenceSystems(prompt)).toThrow();
  });

  it("原样继承六份来源，并覆盖职责、修改、明确数据流、计划和实际问题", () => {
    const inherited = [
      projectChallengeBoundaryCases.find(sample => sample.id === "log-progress")!,
      projectChallengeBoundaryCases.find(sample => sample.id === "csv-unverified")!,
      projectWorkStateCases.find(sample => sample.id === "implemented-flow-current-role-not-authorship")!,
      projectPersonalScopeCases.find(sample => sample.id === "implemented-change-known-author")!,
      projectPersonalScopeCases.find(sample => sample.id === "documentation-known-role")!,
      projectChallengeAdmissionCases.find(sample => sample.id === "observed-issue-without-cause-or-solution")!,
    ];
    expect(projectArchitectureEvidenceCases).toHaveLength(6);
    inherited.forEach((sample, index) => {
      const current = projectArchitectureEvidenceCases[index]!;
      expect({ id: current.id, projectName: current.projectName, source: current.source })
        .toEqual({ id: sample.id, projectName: sample.projectName, source: sample.source });
      expect(current.rubric).toHaveLength(5);
      expect(current.rubric.at(-1)).toMatch(/^审阅流程（不计模型语义判据）：/);
      expect(current.rubric.slice(0, 4).every(item => !item.startsWith("审阅流程"))).toBe(true);
    });
    expect(projectArchitectureEvidenceCases.map(sample => sample.expectedArchitecture)).toEqual([
      "empty", "empty", "preserve-flow", "preserve-flow-separate-change", "empty", "empty",
    ]);
  });

  it("固定12个唯一ID、24项模型判据和6项流程要求，并交替两臂次序", () => {
    const ids = projectArchitectureEvidenceCases.flatMap((sample, caseIndex) => {
      const arms = caseIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      return arms.map(arm => sample.id + "/full/" + arm);
    });
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(projectArchitectureEvidenceCases.reduce((sum, sample) => sum + sample.rubric.slice(0, -1).length, 0) * 2).toBe(48);
    expect(projectArchitectureEvidenceCases.reduce((sum, sample) => sum + sample.rubric.slice(-1).length, 0) * 2).toBe(12);
    expect(projectArchitectureEvidenceCases.map(sample => sample.id)).toEqual([
      "log-progress", "csv-unverified", "implemented-flow-current-role-not-authorship",
      "implemented-change-known-author", "documentation-known-role", "observed-issue-without-cause-or-solution",
    ]);
  });
});
