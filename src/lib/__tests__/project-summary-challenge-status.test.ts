import { describe, expect, it } from "vitest";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "../project-summary-llm";
import {
  buildProjectSummaryChallengeStatusSystems,
  PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE,
  PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE,
  projectSummaryChallengeStatusCases,
} from "../../../evals/project-summary-challenge-status-fixture";

describe("挑战状态准入规则候选的固定契约", () => {
  it("只替换full维度规则中的唯一challenges定义并可逐字恢复", () => {
    const systems = buildProjectSummaryChallengeStatusSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(systems.candidate).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE,
      PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE,
    ));
    expect(systems.candidate).toContain(PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE);
    expect(buildProjectSummaryChallengeStatusSystems(systems.candidate)).toEqual(systems);
    expect(() => buildProjectSummaryChallengeStatusSystems(PROJECT_RESUME_SYSTEM_PROMPT)).toThrow();
  });

  it.each([
    ["missing-definition", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE, "")],
    ["duplicate-definition", PROJECT_SUMMARY_SYSTEM_PROMPT + PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE],
    ["unknown-definition", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE, "challenges 放已观察内容。")],
    ["duplicate-candidate", PROJECT_SUMMARY_SYSTEM_PROMPT.replace(
      PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE,
      PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE + PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE,
    )],
  ] as const)("拒绝未知或不能唯一恢复的提示：%s", (_name, prompt) => {
    expect(() => buildProjectSummaryChallengeStatusSystems(prompt)).toThrow();
  });

  it("沿用六份固定材料和每臂24项模型准则、6项流程要求", () => {
    expect(projectSummaryChallengeStatusCases.map(sample => sample.id)).toEqual([
      "log-progress", "csv-unverified", "implemented-flow-current-role-not-authorship",
      "implemented-change-known-author", "observed-issue-without-cause-or-solution", "started-work-distinct-from-complete",
    ]);
    expect(projectSummaryChallengeStatusCases).toHaveLength(6);
    expect(projectSummaryChallengeStatusCases.reduce((sum, sample) => sum + sample.rubric.slice(0, -1).length, 0)).toBe(24);
    expect(projectSummaryChallengeStatusCases.reduce((sum, sample) => sum + sample.rubric.slice(-1).length, 0)).toBe(6);
    const ids = projectSummaryChallengeStatusCases.flatMap((sample, index) => {
      const arms = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      return arms.map(arm => sample.id + "/full/" + arm);
    });
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    for (const sample of projectSummaryChallengeStatusCases) {
      expect(sample.rubric.at(-1)).toMatch(/^审阅流程（不计模型语义判据）：/);
    }
  });
});
