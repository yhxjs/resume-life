import { it } from "vitest";
import { buildProjectSummaryMessages, PROJECT_REPO_SCAN_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "@/lib/project-summary-llm";
import { emptySummary, isGeneratedProjectSummary } from "@/lib/summary";
import { LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import { buildProjectSummaryArchiveConflictSystems, projectSummaryArchiveConflictCases } from "./project-summary-archive-conflict-fixture";

const systems = buildProjectSummaryArchiveConflictSystems(PROJECT_REPO_SCAN_SYSTEM_PROMPT);
if (systems.candidateV7 !== PROJECT_SUMMARY_SYSTEM_PROMPT) {
  throw new Error("project-summary-archive-conflict candidate-v7 must match the production full-summary prompt");
}
const evaluate = createEvaluationSuite("project-summary-archive-conflict", projectSummaryArchiveConflictCases.length * 8, 8192);
const armSystems = {
  baseline: systems.baseline,
  candidate: systems.candidate,
  "candidate-v2": systems.candidateV2,
  "candidate-v3": systems.candidateV3,
  "candidate-v4": systems.candidateV4,
  "candidate-v5": systems.candidateV5,
  "candidate-v6": systems.candidateV6,
  "candidate-v7": systems.candidateV7,
};

for (const [caseIndex, sample] of projectSummaryArchiveConflictCases.entries()) {
  const input = {
    projectName: sample.projectName,
    materials: sample.materials,
    materialText: sample.materials.map(serializeProjectSummaryMaterial).join(""),
    archive: sample.archive || emptySummary(),
    mode: "full" as const,
  };
  const messages = buildProjectSummaryMessages(input);
  const arms = caseIndex % 2 === 0
    ? ["baseline", "candidate", "candidate-v2", "candidate-v3", "candidate-v4", "candidate-v5", "candidate-v6", "candidate-v7"] as const
    : ["candidate-v7", "candidate-v6", "candidate-v5", "candidate-v4", "candidate-v3", "candidate-v2", "candidate", "baseline"] as const;
  for (const arm of arms) {
    it(`${sample.id}/${arm}`, async () => {
      await evaluate({
        id: `${sample.id}/${arm}`,
        input,
        system: armSystems[arm],
        messages,
        rubric: sample.rubric,
        call: options => safeChatStream("summary", { feature: LLM_FEATURES.projectSummarize }, armSystems[arm], messages, () => {}, options),
        validate: raw => isGeneratedProjectSummary(raw),
      });
    });
  }
}
