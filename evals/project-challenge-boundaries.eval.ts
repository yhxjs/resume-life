import { it } from "vitest";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "@/lib/project-summary-llm";
import { emptySummary, isGeneratedProjectSummary } from "@/lib/summary";
import { LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import { buildProjectChallengeBoundaryCandidate, projectChallengeBoundaryCases } from "./project-challenge-boundaries-fixture";

const baseline = PROJECT_SUMMARY_SYSTEM_PROMPT;
const candidate = buildProjectChallengeBoundaryCandidate(baseline);
const evaluate = createEvaluationSuite("project-challenge-boundaries", projectChallengeBoundaryCases.length * 2, 8192);

for (const [index, sample] of projectChallengeBoundaryCases.entries()) {
  const materials = [{ title: "合成项目记录", content: sample.source }];
  const input = {
    projectName: sample.projectName, materials,
    materialText: materials.map(serializeProjectSummaryMaterial).join(""),
    archive: emptySummary(), mode: "full",
  };
  const messages = buildProjectSummaryMessages(input);
  // Every arm executes once; order alternates by case, without selective retries or paired resampling.
  const arms = index % 2 === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
  for (const arm of arms) {
    it(`${sample.id}/${arm}`, async () => {
      const system = arm === "baseline" ? baseline : candidate;
      await evaluate({
        id: `${sample.id}/${arm}`, input, system, messages, rubric: [...sample.rubric],
        call: options => safeChatStream("summary", { feature: LLM_FEATURES.projectSummarize }, system, messages, () => {}, options),
        validate: isGeneratedProjectSummary,
      });
    });
  }
}
