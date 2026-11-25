import * as z from "zod/v4";
import { JD_PORTRAIT_OUTPUT_LIMITS } from "./jd-portrait";
import { DIAGNOSIS_OUTPUT_LIMITS } from "./diagnosis";
import { REVIEW_RESULT_MAX_TEXT_CHARS, REVIEW_RESUME_SUGGESTION_MAX_CHARS } from "./application-interview-review";
import { STANDALONE_DRILL_QUESTION_MAX_CHARS } from "./prompt-guidelines";

/** Machine-readable output guidance. Domain validators additionally check visible
 * content, duplicate targets/questions, source ownership and total archive budgets. */
export function mcpDraftResultSchema(kind: "jd" | "diagnosis" | "review", moduleKeys: string[] = [], questionCount = 0) {
  const text = (max: number) => z.string().min(1).max(max);
  if (kind === "jd") {
    const limits = JD_PORTRAIT_OUTPUT_LIMITS;
    return z.toJSONSchema(z.strictObject({
      role: text(limits.role),
      must_skills: z.array(z.strictObject({ name: text(limits.skillName), weight: z.number().int().min(1).max(10), why: text(limits.skillWhy) })).max(limits.skills),
      followups: z.array(z.strictObject({ topic: text(limits.topic), questions: z.array(text(limits.question)).min(1).max(limits.questions) })).max(limits.followups),
      company_style: z.strictObject({ style: text(limits.companyStyle), signals: z.array(text(limits.signal)).max(limits.signals) }),
    }));
  }
  if (kind === "diagnosis") {
    const limits = DIAGNOSIS_OUTPUT_LIMITS;
    const score = z.number().int().min(1).max(10);
    const suggestion = z.discriminatedUnion("field", [
      z.strictObject({ item_id: z.string().min(1), field: z.literal("description"), reason: text(limits.reason), draft: text(limits.descriptionDraft) }),
      z.strictObject({ item_id: z.literal(""), field: z.literal("text"), reason: text(limits.reason), draft: text(limits.textDraft) }),
      z.strictObject({ item_id: z.literal(""), field: z.literal("items"), reason: text(limits.reason), draft: z.array(text(limits.skill)).min(1).max(limits.maxSkills) }),
    ]);
    return z.toJSONSchema(z.strictObject({
      match: z.number().min(0).max(10).multipleOf(0.1), summary: text(limits.summary),
      modules: z.array(z.strictObject({ module_key: z.enum(moduleKeys),
        scores: z.strictObject({ depth: score, structure: score, authenticity: score, completeness: score }),
        gaps: z.string().max(limits.gaps), suggestions: z.array(suggestion),
      })).length(moduleKeys.length),
    }));
  }
  const question_index = z.number().int().min(1).max(questionCount);
  return z.toJSONSchema(z.strictObject({
    mistakes: z.array(z.strictObject({ question_index, gap: text(REVIEW_RESULT_MAX_TEXT_CHARS), improved_answer: text(REVIEW_RESULT_MAX_TEXT_CHARS) })).max(questionCount),
    drills: z.array(z.strictObject({ question_index, question: text(STANDALONE_DRILL_QUESTION_MAX_CHARS) })).max(questionCount),
    resume_suggestions: z.array(z.strictObject({ question_index, suggestion: text(REVIEW_RESUME_SUGGESTION_MAX_CHARS) })).max(questionCount),
  }));
}
