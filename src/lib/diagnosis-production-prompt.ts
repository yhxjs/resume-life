import { DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT as basePrompt } from "./diagnosis-prompt-base";
import { DIAGNOSIS_ADOPTED_CONFLICT_RULE, DIAGNOSIS_PREVIOUS_CONFLICT_RULE } from "./diagnosis-conflict-prompt";

export { DIAGNOSIS_ADOPTED_SUMMARY_RULES } from "./diagnosis-prompt-base";

if (basePrompt.split(DIAGNOSIS_PREVIOUS_CONFLICT_RULE).length !== 2) {
  throw new Error("Diagnosis conflict policy anchor must occur exactly once");
}

export const DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT = basePrompt.replace(
  DIAGNOSIS_PREVIOUS_CONFLICT_RULE,
  DIAGNOSIS_ADOPTED_CONFLICT_RULE,
);
