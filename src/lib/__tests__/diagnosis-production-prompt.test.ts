import { expect, it } from "vitest";
import { DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT as basePrompt, DIAGNOSIS_ADOPTED_SUMMARY_RULES } from "../diagnosis-prompt-base";
import { DIAGNOSIS_ADOPTED_CONFLICT_RULE, DIAGNOSIS_PREVIOUS_CONFLICT_RULE } from "../diagnosis-conflict-prompt";
import { DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT } from "../diagnosis-production-prompt";

it("composes the production conflict rule with the diagnosis base prompt", () => {
  expect(basePrompt).toContain(DIAGNOSIS_PREVIOUS_CONFLICT_RULE);
  expect(basePrompt.indexOf(DIAGNOSIS_PREVIOUS_CONFLICT_RULE)).toBe(basePrompt.lastIndexOf(DIAGNOSIS_PREVIOUS_CONFLICT_RULE));
  expect(DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT).toBe(basePrompt.replace(DIAGNOSIS_PREVIOUS_CONFLICT_RULE, DIAGNOSIS_ADOPTED_CONFLICT_RULE));
  expect(DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT.endsWith("\n" + DIAGNOSIS_ADOPTED_SUMMARY_RULES)).toBe(true);
});
