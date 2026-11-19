import { writeFileSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "@/lib/project-summary-llm";
import { emptySummary, isGeneratedProjectSummary } from "@/lib/summary";
import { LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import { buildProjectChallengeEvidenceSystem, consumeProjectChallengeEvidence } from "./project-challenge-evidence";
import { projectChallengeEvidenceCases } from "./project-challenge-evidence-fixture";

const systems = { baseline: PROJECT_SUMMARY_SYSTEM_PROMPT, candidate: buildProjectChallengeEvidenceSystem() };
const evaluate = createEvaluationSuite("project-challenge-evidence", projectChallengeEvidenceCases.length * 2, 8192);

for (const [index, sample] of projectChallengeEvidenceCases.entries()) {
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
        validate: raw => {
          if (arm === "baseline") return isGeneratedProjectSummary(raw);
          const consumed = consumeProjectChallengeEvidence(raw, materials);
          // The harness retains the original raw response even if consumption fails.
          // A separate artifact exposes the exact legacy eight-field representation for semantic review.
          writeFileSync(path.join(process.env.PROMPT_EVAL_OUTPUT!, `${sample.id}-full-candidate-consumed.json`),
            JSON.stringify({ schemaVersion: 1, id: `${sample.id}/full/candidate`, summary: consumed }, null, 2), { mode: 0o600 });
          return consumed !== null;
        },
      });
    });
  }
}
