import { it } from "vitest";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "@/lib/project-summary-llm";
import { emptySummary, isGeneratedProjectSummary } from "@/lib/summary";
import { LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import { buildProjectChallengeOrderSystems, projectChallengeOrderCases } from "./project-challenge-order-fixture";

const systems = buildProjectChallengeOrderSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
const evaluate = createEvaluationSuite("project-challenge-order", projectChallengeOrderCases.length * 2, 8192);

for (const [index, sample] of projectChallengeOrderCases.entries()) {
  const materials = [{ title: "合成项目记录", content: sample.source }];
  const input = {
    projectName: sample.projectName, materials,
    materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode: "full",
  };
  const messages = buildProjectSummaryMessages(input);
  const arms = index % 2 === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
  for (const arm of arms) {
    it(`${sample.id}/full/${arm}`, async () => {
      const system = systems[arm];
      await evaluate({
        id: `${sample.id}/full/${arm}`, input, system, messages, rubric: [...sample.rubric],
        call: options => safeChatStream("summary", { feature: LLM_FEATURES.projectSummarize }, system, messages, () => {}, options),
        validate: isGeneratedProjectSummary,
      });
    });
  }
}
