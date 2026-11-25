import * as z from "zod/v4";
import { RESUME_DEFENSE_OUTPUT_LIMITS as D } from "./resume-defense";
import { RESUME_DEFENSE_DRILL_OUTPUT_LIMITS as E } from "./model-protocol";
import { REMEDY_OUTPUT_LIMITS as G } from "./career-gap-remedy";
import { NEGOTIATION_OUTPUT_LIMITS as S } from "./salary-negotiation";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).default("");
export const careerSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("defense"), title: optionalText(200), targetRole: optionalText(200), material: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("resume"), resumeId: id, versionId: id }), z.strictObject({ type: z.literal("text"), content: text(60_000) }),
  ]) }),
  z.strictObject({ kind: z.literal("defense-drill"), defenseId: id, itemId: text(100), question: text(4000), answer: text(20_000) }),
  z.strictObject({ kind: z.literal("gap"), scenarioType: z.enum(["resignation", "gap", "both"]).default("both"), rawStory: text(20_000), targetRole: optionalText(200), personaStyle: z.enum(["pragmatic", "driven", "composed"]).default("pragmatic") }),
  z.strictObject({ kind: z.literal("salary-create"), targetCompanyTier: text(500).default("top_tech"), targetRole: text(200), expectedSalary: text(4000), currentOrCompetingOffer: optionalText(4000), hrStyle: z.enum(["pressure", "standard", "emotional"]).default("standard") }),
  z.strictObject({ kind: z.literal("salary-turn"), negotiationId: id, userMessage: text(4000) }),
  z.strictObject({ kind: z.literal("salary-finalize"), negotiationId: id, finalWords: optionalText(4000), agreedPackage: optionalText(4000) }),
]);
export type CareerSource = z.output<typeof careerSourceSchema>;
const defenseResult = z.strictObject({ risk_level: z.enum(["critical", "high", "medium", "low"]), overall_roast: text(D.overall_roast), items: z.array(z.strictObject({
  original_text: text(20_000), section_hint: text(D.section_hint), risk_level: z.enum(["critical", "high", "medium"]),
  risk_type: z.enum(["vague_phrase", "data_suspicion", "buzzword_stuffing", "scope_ambiguity", "logic_flaw"]), interviewer_roast: text(D.interviewer_roast),
  deadly_questions: z.array(text(D.deadly_question)).min(D.min_deadly_questions).max(D.max_deadly_questions),
  defense_plan: z.strictObject({ interviewer_intent: text(D.interviewer_intent), standard_defense: text(D.standard_defense), taboo_mistakes: z.array(text(D.taboo_mistake)).max(D.max_taboo_mistakes) }),
})).max(D.max_items) });
const defenseDrill = z.strictObject({ defense_score: z.number().min(0).max(100), interviewer_roast: text(E.interviewer_roast), defense_critique: text(E.defense_critique), improved_answer: text(E.improved_answer) });
const script = z.strictObject({ label: text(G.label), applicable_scene: text(G.scene), script: text(G.script), key_points: z.array(text(G.listItem)).min(1).max(G.listItems) });
const gapResult = z.strictObject({ title: text(G.title), punchline: text(G.punchline),
  hr_mindset_analysis: z.strictObject({ core_concerns: z.array(text(G.listItem)).max(G.listItems), risk_points: z.array(text(G.listItem)).max(G.listItems), what_hr_wants_to_hear: text(G.analysis) }),
  reframe_formula: z.strictObject({ fact_acknowledgment: text(G.formula), positive_attribution: text(G.formula), growth_and_value: text(G.formula), motivation_alignment: text(G.formula) }),
  scripts: z.strictObject({ concise: script, detailed: script, pivoting: script }),
  drills: z.array(z.strictObject({ question: text(G.drillQuestion), hr_concern: text(G.drillConcern), best_response: text(G.drillResponse) })).max(G.drills),
  forbidden_list: z.array(text(G.adviceItem)).max(G.forbiddenItems), closing_tips: z.array(text(G.adviceItem)).min(1).max(G.listItems),
});
const salaryTurn = z.strictObject({ hr_response: text(S.hr_response), hr_tactics: text(S.hr_tactics),
  hr_mindset: z.strictObject({ looseness: z.number().int().min(0).max(100), current_attitude: text(S.current_attitude), estimated_package: text(S.estimated_package), tactics_label: text(S.tactics_label), internal_pressure: text(S.internal_pressure) }),
  mentor_analysis: z.strictObject({ user_argument_score: z.number().int().min(1).max(10), strengths: z.array(text(S.strength)).min(1).max(S.max_observations),
    vulnerabilities: z.array(text(S.vulnerability)).min(1).max(S.max_observations), tactical_tips: text(S.tactical_tips),
    suggested_replies: z.array(z.strictObject({ title: text(S.reply_title), content: text(S.reply_content), rationale: text(S.reply_rationale) })).min(1).max(S.max_replies) }),
});
const salaryFinal = z.strictObject({ final_package_summary: text(S.final_package_summary), score: z.number().int().min(0).max(100), leverage_efficiency: text(S.leverage_efficiency),
  turn_critiques: z.array(z.strictObject({ turn_no: id, gain_or_loss: z.enum(["gain", "loss", "neutral"]), summary: text(S.critique_summary), key_point: text(S.critique_key_point) })).max(20),
  real_world_tips: z.array(text(S.real_world_tip)).min(1).max(S.max_real_world_tips), mentor_summary: text(S.mentor_summary) });
export const careerResults = { defense: defenseResult, "defense-drill": defenseDrill, gap: gapResult,
  "salary-create": salaryTurn.extend({ initial_offer: text(S.initial_offer), mentor_analysis: salaryTurn.shape.mentor_analysis.extend({ user_argument_score: z.literal(5) }) }),
  "salary-turn": salaryTurn, "salary-finalize": salaryFinal };
export const careerResultSchema = z.union([careerResults.defense, careerResults["defense-drill"], careerResults.gap, careerResults["salary-create"], salaryTurn, salaryFinal]);
