import { getDb, inTransaction, now } from "./db";
import type { PersonaStyle, ResignationGapRemedyResult, ScenarioType } from "./career-gap-remedy";
import type { HrMindset, HrStyle, MentorAnalysis, NegotiationReport } from "./salary-negotiation";

export function createCareerGapRemedy(input: { scenarioType: ScenarioType; rawStory: string; targetRole: string; personaStyle: PersonaStyle }, result: ResignationGapRemedyResult) {
  return Number(getDb().prepare("INSERT INTO resignation_gap_remedies (scenario_type,raw_story,target_role,persona_style,result,created_at) VALUES (?,?,?,?,?,?)")
    .run(input.scenarioType, input.rawStory, input.targetRole, input.personaStyle, JSON.stringify(result), now()).lastInsertRowid);
}

type SalaryResponse = { hr_response: string; hr_tactics: string; hr_mindset: HrMindset; mentor_analysis: MentorAnalysis };
export function insertSalaryTurn(id: number, turnNo: number, userMessage: string, result: SalaryResponse, at: string) {
  return getDb().prepare("INSERT INTO salary_negotiation_turns (negotiation_id,turn_no,user_message,hr_response,hr_tactics,hr_mindset,mentor_analysis,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, turnNo, userMessage, result.hr_response, result.hr_tactics, JSON.stringify(result.hr_mindset), JSON.stringify(result.mentor_analysis), at);
}

export function createSalaryNegotiation(input: { targetCompanyTier: string; targetRole: string; expectedSalary: string; currentOrCompetingOffer: string; hrStyle: HrStyle }, result: SalaryResponse & { initial_offer: string }, at = now()) {
  return inTransaction(() => {
    const id = Number(getDb().prepare("INSERT INTO salary_negotiations (target_company_tier,target_role,expected_salary,current_or_competing_offer,hr_style,status,initial_offer,created_at) VALUES (?,?,?,?,?,'ongoing',?,?)")
      .run(input.targetCompanyTier, input.targetRole, input.expectedSalary, input.currentOrCompetingOffer, input.hrStyle, result.initial_offer, at).lastInsertRowid);
    insertSalaryTurn(id, 1, "", result, at);
    return id;
  });
}

export function storeSalaryReport(id: number, expectedStatus: string, expectedTurnCount: number, finalPackage: string, report: NegotiationReport, at: string) {
  return getDb().prepare("UPDATE salary_negotiations SET status='finished',final_package=?,report=?,finished_at=? WHERE id=? AND status=? AND (SELECT COUNT(*) FROM salary_negotiation_turns WHERE negotiation_id=?)=?")
    .run(finalPackage, JSON.stringify(report), at, id, expectedStatus, id, expectedTurnCount);
}
