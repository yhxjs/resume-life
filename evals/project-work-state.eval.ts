import { it } from "vitest";
import { buildProjectSummaryMessages, PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "@/lib/project-summary-llm";
import { emptySummary, isGeneratedProjectSummary, validateGeneratedProjectResume } from "@/lib/summary";
import { LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import { buildProjectWorkStateSystems, projectWorkStateCases } from "./project-work-state-fixture";

const systems = {
  full: buildProjectWorkStateSystems(PROJECT_SUMMARY_SYSTEM_PROMPT),
  "resume-only": buildProjectWorkStateSystems(PROJECT_RESUME_SYSTEM_PROMPT),
};
const evaluate = createEvaluationSuite("project-work-state", projectWorkStateCases.length * 4, 8192);

for (const [caseIndex, sample] of projectWorkStateCases.entries()) {
  const materials = [{ title: "合成项目记录", content: sample.source }];
  for (const [modeIndex, mode] of (["full", "resume-only"] as const).entries()) {
    const input = { projectName: sample.projectName, materials,
      materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode };
    const messages = buildProjectSummaryMessages(input);
    const arms = (caseIndex + modeIndex) % 2 === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
    for (const arm of arms) {
      it(`${sample.id}/${mode}/${arm}`, async () => {
        const system = systems[mode][arm];
        await evaluate({
          id: `${sample.id}/${mode}/${arm}`, input, system, messages, rubric: [...sample.rubric],
          call: options => safeChatStream("summary", { feature: LLM_FEATURES.projectSummarize }, system, messages, () => {}, options),
          validate: raw => mode === "full" ? isGeneratedProjectSummary(raw) : validateGeneratedProjectResume(raw),
        });
      });
    }
  }
}
