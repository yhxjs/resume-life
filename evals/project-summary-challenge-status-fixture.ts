import { projectSummaryFieldBoundariesCases } from "./project-summary-field-boundaries-fixture";

export const PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE = "challenges 放实际问题及处理依据。";
export const PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE = "challenges只填材料明确记录的实际问题和处理依据；未运行测试、未发布、局部核对符合预期等状态不单独成为问题；处理结果只保留材料已知内容。";
/** Replace only the existing full-summary dimension rule; preserve every other prompt byte. */
export function buildProjectSummaryChallengeStatusSystems(production: string): { baseline: string; candidate: string } {
  const baselineCount = production.split(PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE).length - 1;
  const candidateCount = production.split(PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE).length - 1;
  if (baselineCount + candidateCount !== 1) {
    throw new Error("project-summary-challenge-status requires one known full-summary challenges rule");
  }
  const baseline = candidateCount ? production.replace(PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE, PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE) : production;
  return { baseline, candidate: baseline.replace(PROJECT_SUMMARY_CHALLENGE_STATUS_BASELINE_RULE, PROJECT_SUMMARY_CHALLENGE_STATUS_CANDIDATE_RULE) };
}

export const projectSummaryChallengeStatusCases = projectSummaryFieldBoundariesCases;
