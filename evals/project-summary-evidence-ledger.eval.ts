import { it } from "vitest";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "@/lib/project-summary-llm";
import { emptySummary, isGeneratedProjectSummary } from "@/lib/summary";
import { LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";
import {
  buildProjectSummaryEvidenceLedgerSystems,
  isProjectSummaryEvidenceLedger,
  projectSummaryEvidenceLedgerCases,
} from "./project-summary-evidence-ledger-fixture";

const systems = buildProjectSummaryEvidenceLedgerSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
const evaluate = createEvaluationSuite("project-summary-evidence-ledger", projectSummaryEvidenceLedgerCases.length * 2, 8192);

for (const [caseIndex, sample] of projectSummaryEvidenceLedgerCases.entries()) {
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
    const system = systems[arm];
    it(sample.id + "/full/" + arm, async () => {
      await evaluate({
        id: sample.id + "/full/" + arm,
        input,
        system,
        messages,
        rubric: [...sample.rubric],
        call: options => safeChatStream("summary", { feature: LLM_FEATURES.projectSummarize }, system, messages, () => {}, options),
        validate: raw => arm === "baseline"
          ? isGeneratedProjectSummary(raw)
          : isProjectSummaryEvidenceLedger(raw, sample.source),
      });
    });
  }
}
