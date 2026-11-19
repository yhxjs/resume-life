import { it } from "vitest";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "@/lib/project-summary-llm";
import { emptySummary, isGeneratedProjectSummary } from "@/lib/summary";
import { LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import { buildProjectSummaryFieldBoundariesSystems, projectSummaryFieldBoundariesCases } from "./project-summary-field-boundaries-fixture";

const systems = buildProjectSummaryFieldBoundariesSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
const evaluate = createEvaluationSuite("project-summary-field-boundaries", projectSummaryFieldBoundariesCases.length * 2, 8192);

for (const [caseIndex, sample] of projectSummaryFieldBoundariesCases.entries()) {
  const materials = [{ title: "合成项目记录", content: sample.source }];
  const input = {
    projectName: sample.projectName,
    materials,
    materialText: materials.map(serializeProjectSummaryMaterial).join(""),
    archive: emptySummary(),
    mode: "full" as const,
  };
  const messages = buildProjectSummaryMessages(input);
  const arms = (caseIndex % 2) === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
  for (const arm of arms) {
    it(sample.id + "/full/" + arm, async () => {
      await evaluate({
        id: sample.id + "/full/" + arm,
        input,
        system: systems[arm],
        messages,
        rubric: [...sample.rubric],
        call: options => safeChatStream("summary", { feature: LLM_FEATURES.projectSummarize }, systems[arm], messages, () => {}, options),
        validate: raw => isGeneratedProjectSummary(raw),
      });
    });
  }
}
