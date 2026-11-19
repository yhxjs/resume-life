import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import {
  buildProjectChallengeAdmissionSystems,
  PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE,
  PROJECT_CHALLENGE_ADMISSION_CANDIDATE_LINE,
  projectChallengeAdmissionCases,
} from "../../../evals/project-challenge-admission-fixture";
import { projectWorkStateCases } from "../../../evals/project-work-state-fixture";
import { projectChallengeBoundaryCases } from "../../../evals/project-challenge-boundaries-fixture";

describe("技术难点字段准入候选的固定实验契约", () => {
  it("只替换full示例中的一个challenges值，恢复后逐字等于生产提示", () => {
    const systems = buildProjectChallengeAdmissionSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.baseline).toContain(PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE);
    expect(systems.candidate).toContain(PROJECT_CHALLENGE_ADMISSION_CANDIDATE_LINE);
    expect(systems.candidate.replace(PROJECT_CHALLENGE_ADMISSION_CANDIDATE_LINE, PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE))
      .toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(buildProjectChallengeAdmissionSystems(systems.candidate)).toEqual(systems);
    expect(() => buildProjectChallengeAdmissionSystems(PROJECT_RESUME_SYSTEM_PROMPT)).toThrow();
  });

  it.each([
    ["missing-field", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE, "")],
    ["duplicate-field", PROJECT_SUMMARY_SYSTEM_PROMPT + "\n" + PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE],
    ["unknown-field-value", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_CHALLENGE_ADMISSION_BASELINE_LINE, '  "challenges": "未知说明",')],
    ["prior-work-state-addition", PROJECT_SUMMARY_SYSTEM_PROMPT.replace("工作范围：\n", "工作范围：\n- 职责分工只说明责任范围，不证明相关工作已实施或完成；未给实施状态时保持未知，不补成已实现或改成未实现。有独立实现证据时照常保留，不要求实现者已知。\n")],
    ["prior-boundary-addition", PROJECT_SUMMARY_SYSTEM_PROMPT + "\n纯进度或阶段状态本身不是难点"],
  ] as const)("拒绝无法唯一恢复的提示：%s", (_name, prompt) => {
    expect(() => buildProjectChallengeAdmissionSystems(prompt)).toThrow();
  });

  it("继承10份材料和原判据，只在原流程项之前插入难点直接目标", () => {
    const previous = [...projectWorkStateCases, ...projectChallengeBoundaryCases.filter(sample => sample.id === "log-progress" || sample.id === "csv-unverified")];
    expect(projectChallengeAdmissionCases).toHaveLength(12);
    previous.forEach((sample, index) => {
      const current = projectChallengeAdmissionCases[index]!;
      expect({ id: current.id, projectName: current.projectName, source: current.source })
        .toEqual({ id: sample.id, projectName: sample.projectName, source: sample.source });
      expect(current.rubric.slice(0, -2)).toEqual(sample.rubric.slice(0, -1));
      expect(current.rubric.at(-1)).toBe(sample.rubric.at(-1));
      expect(current.rubric.at(-2)).toMatch(/^难点直接目标：/);
      expect(current.challengeCriterionPosition).toBe(current.rubric.length - 1);
    });
  });

  it("固定覆盖24个唯一ID，交替两臂并核对56项模型判据与12项流程要求", () => {
    const ids = projectChallengeAdmissionCases.flatMap((sample, caseIndex) => {
      const arms = caseIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      return arms.map(arm => sample.id + "/full/" + arm);
    });
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24);
    expect(projectChallengeAdmissionCases.reduce((sum, sample) => sum + sample.rubric.length - 1, 0) * 2).toBe(112);
    expect(projectChallengeAdmissionCases.reduce((sum) => sum + 1, 0) * 2).toBe(24);
    expect(new Set(projectChallengeAdmissionCases.filter(sample => sample.expectedChallenge === "problem").map(sample => sample.id)))
      .toEqual(new Set(["log-unresolved", "csv-verified", "csv-unverified", "observed-issue-without-cause-or-solution"]));
  });
});
