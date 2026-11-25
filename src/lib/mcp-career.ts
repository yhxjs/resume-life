import * as z from "zod/v4";
import { getDb, inTransaction, now } from "./db";
import { collectResumeEvidenceParts, formatResumeContext, formatResumeEvidenceText, loadResumeForModel } from "./resumes";
import { resolveResumeVersionId } from "./resume-versions";
import { getDefenseReport, getDefenseDrill, saveDefenseReport, saveDefenseDrill, validateGeneratedDefenseReport } from "./resume-defense";
import { buildResumeDefenseScanMessages, buildResumeDefenseDrillMessages, RESUME_DEFENSE_SCAN_SYSTEM_PROMPT, RESUME_DEFENSE_DRILL_SYSTEM_PROMPT } from "./resume-defense-llm";
import { parseDefenseDrillEvaluation } from "./model-protocol";
import { validateGeneratedRemedyResult } from "./career-gap-remedy";
import { buildCareerGapRemedyMessages, CAREER_GAP_REMEDY_SYSTEM_PROMPT } from "./career-gap-remedy-llm";
import { describeNegotiationCompany, describeNegotiationHrStyle, HR_STYLE_OPTIONS, validateGeneratedNegotiationOpening, validateGeneratedNegotiationTurn, validateGeneratedNegotiationReport } from "./salary-negotiation";
import { buildOpeningMessages, buildTurnHistoryMessages, buildFinalizeMessages, SALARY_NEGOTIATION_OPENING_PROMPT, SALARY_NEGOTIATION_TURN_PROMPT, SALARY_NEGOTIATION_FINALIZE_PROMPT } from "./salary-negotiation-llm";
import { readSalaryNegotiationSnapshot } from "./salary-negotiation-snapshot";
import { createCareerGapRemedy, createSalaryNegotiation, insertSalaryTurn, storeSalaryReport } from "./career-tool-store";
import { careerResults, type CareerSource } from "./mcp-career-contract";
import { assertMcpContext, mcpContextPage, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpCreateOnce } from "./mcp-state";
import { fitPage, pageParams, type PageInput } from "./mcp-read";

function capture(source: CareerSource) {
  const resultSchema = z.toJSONSchema(careerResults[source.kind]);
  if (source.kind === "defense") {
    const material = source.material;
    let content: string, evidence: string, evidenceParts: string[];
    if (material.type === "resume") {
      resolveResumeVersionId(material.resumeId, material.versionId);
      const resume = loadResumeForModel(material.resumeId, material.versionId);
      if (!resume) throw new McpOperationError("NOT_FOUND", "简历不存在");
      content = formatResumeContext(resume.modules); evidence = formatResumeEvidenceText(resume.modules); evidenceParts = collectResumeEvidenceParts(resume.modules);
    } else { content = evidence = material.content; evidenceParts = [evidence]; }
    return { source, resultSchema, content, evidence, evidenceParts, rules: RESUME_DEFENSE_SCAN_SYSTEM_PROMPT, messages: buildResumeDefenseScanMessages(source.targetRole, content) };
  }
  if (source.kind === "defense-drill") {
    const report = getDefenseReport(source.defenseId), item = report?.items.find(item => item.id === source.itemId);
    if (!report || !item) throw new McpOperationError("NOT_FOUND", "排雷报告或条目不存在");
    const previousDrill = getDefenseDrill(source.defenseId, source.itemId);
    return { source, resultSchema, report, item, previousDrill, rules: RESUME_DEFENSE_DRILL_SYSTEM_PROMPT,
      messages: buildResumeDefenseDrillMessages({ resumeSource: report.sourceContent, originalText: item.originalText, question: source.question, defensePlan: item.defensePlan.standardDefense, answer: source.answer }) };
  }
  if (source.kind === "gap") return { source, resultSchema, rules: CAREER_GAP_REMEDY_SYSTEM_PROMPT, messages: buildCareerGapRemedyMessages(source) };
  if (source.kind === "salary-create") {
    const style = HR_STYLE_OPTIONS.find(style => style.key === source.hrStyle)!;
    return { source, resultSchema, rules: SALARY_NEGOTIATION_OPENING_PROMPT, messages: buildOpeningMessages({ ...source,
      targetCompanyTier: describeNegotiationCompany(source.targetCompanyTier), hrStyleDesc: describeNegotiationHrStyle(style) }) };
  }
  const snapshot = readSalaryNegotiationSnapshot(source.negotiationId);
  if (!snapshot) throw new McpOperationError("NOT_FOUND", "谈判记录不存在");
  const { negotiation, turns } = snapshot;
  if (negotiation.status !== "ongoing" || negotiation.report) throw new McpOperationError("CONFLICT", "谈判已结束，请核对正式报告");
  const background = { targetCompanyTier: describeNegotiationCompany(negotiation.target_company_tier), targetRole: negotiation.target_role,
    expectedSalary: negotiation.expected_salary, currentOrCompetingOffer: negotiation.current_or_competing_offer, initialOffer: negotiation.initial_offer };
  if (source.kind === "salary-turn") {
    const style = HR_STYLE_OPTIONS.find(style => style.key === negotiation.hr_style);
    if (!style) throw new McpOperationError("INVALID_ARGUMENT", "历史 HR 风格无效");
    return { source, resultSchema, snapshot, rules: SALARY_NEGOTIATION_TURN_PROMPT, messages: buildTurnHistoryMessages({ ...background,
      hrStyleDesc: describeNegotiationHrStyle(style), turns, newUserMessage: source.userMessage }) };
  }
  return { source, resultSchema, snapshot, rules: SALARY_NEGOTIATION_FINALIZE_PROMPT, messages: buildFinalizeMessages({ ...background,
    turns: turns.map(turn => ({ ...turn, hr_mindset_str: turn.hr_mindset, mentor_analysis_str: turn.mentor_analysis })), finalWords: source.finalWords, agreedPackage: source.agreedPackage }) };
}

export function getCareerWorkflowContext(source: CareerSource, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(source), page));
}

export function saveCareerResult(input: { source: CareerSource; expectedRevision: string; result: object; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_career_result", idempotencyKey, payload, () => {
    const source = input.source, context = capture(source);
    assertMcpContext(context, input.expectedRevision);
    const invalid = () => new McpOperationError("INVALID_ARGUMENT", "结果结构、引用依据或篇幅无效，请按上下文 resultSchema 核对");
    if (!careerResults[source.kind].safeParse(input.result).success) throw invalid();
    if (source.kind === "defense") {
      const result = validateGeneratedDefenseReport(input.result, context.evidence!, context.evidenceParts!);
      if (!result) throw invalid();
      const material = source.material;
      return { id: saveDefenseReport({ resumeId: material.type === "resume" ? material.resumeId : null, resumeVersionId: material.type === "resume" ? material.versionId : null,
        title: source.title, targetRole: source.targetRole, sourceContent: context.evidence!, ...result }, material.type === "resume" ? { resumeContext: context.content! } : undefined).id };
    }
    if (source.kind === "defense-drill") {
      const result = parseDefenseDrillEvaluation(JSON.stringify(input.result));
      return { id: saveDefenseDrill({ defenseId: source.defenseId, itemId: source.itemId, question: source.question, userAnswer: source.answer,
        interviewerRoast: result.interviewer_roast, defenseScore: result.defense_score, defenseCritique: result.defense_critique, improvedAnswer: result.improved_answer },
      { sourceContent: context.report!.sourceContent, originalText: context.item!.originalText, defaultDefensePlan: context.item!.defensePlan.standardDefense, previousDrill: context.previousDrill! }).id };
    }
    if (source.kind === "gap") {
      const result = validateGeneratedRemedyResult(input.result);
      if (!result) throw invalid();
      return { id: createCareerGapRemedy(source, result) };
    }
    if (source.kind === "salary-create") {
      const result = validateGeneratedNegotiationOpening(input.result);
      if (!result) throw invalid();
      return { id: createSalaryNegotiation(source, result) };
    }
    const { negotiation, turns } = context.snapshot!;
    if (source.kind === "salary-turn") {
      const result = validateGeneratedNegotiationTurn(input.result);
      if (!result) throw invalid();
      const next = Math.max(0, ...turns.map(turn => turn.turn_no)) + 1;
      return { id: Number(insertSalaryTurn(negotiation.id, next, source.userMessage, result, now()).lastInsertRowid) };
    }
    const result = validateGeneratedNegotiationReport(input.result, turns.filter(turn => turn.user_message.trim()).map(turn => turn.turn_no));
    if (!result) throw invalid();
    const saved = storeSalaryReport(negotiation.id, negotiation.status, turns.length, source.agreedPackage || result.final_package_summary, result, now());
    if (saved.changes !== 1) throw new McpOperationError("CONFLICT", "谈判状态已变化，请重新读取");
    return { id: negotiation.id };
  }, id => {
    const tables = { defense: "resume_defenses", "defense-drill": "resume_defense_drills", gap: "resignation_gap_remedies", "salary-create": "salary_negotiations", "salary-turn": "salary_negotiation_turns", "salary-finalize": "salary_negotiations" } as const;
    return !!getDb().prepare(`SELECT 1 FROM ${tables[input.source.kind]} WHERE id=?`).get(id);
  });
}

export const CAREER_RECORD_KINDS = ["resume_defense", "career_gap_remedy", "salary_negotiation"] as const;
type CareerRecordKind = typeof CAREER_RECORD_KINDS[number];
const specs = {
  resume_defense: { table: "resume_defenses", title: "title", text: "title || ' ' || target_role || ' ' || source_content" },
  career_gap_remedy: { table: "resignation_gap_remedies", title: "target_role", text: "target_role || ' ' || raw_story" },
  salary_negotiation: { table: "salary_negotiations", title: "target_role", text: "target_role || ' ' || target_company_tier" },
} as const;
export function listCareerRecords(kind: CareerRecordKind, input: PageInput & { q?: string }) {
  const { idCursor, limit } = pageParams(input), spec = specs[kind];
  const rows = getDb().prepare(`SELECT id,${spec.title} AS title,created_at FROM ${spec.table} WHERE (? IS NULL OR id<?) AND instr(lower(${spec.text}),lower(?))>0 ORDER BY id DESC LIMIT ?`)
    .all(idCursor, idCursor, input.q?.trim() ?? "", limit + 1) as { id: number; title: string; created_at: string }[];
  const items = rows.slice(0, limit).map(row => ({ ...row, kind, fullContent: { tool: "get_career_record", kind, id: row.id } }));
  return fitPage(items, rows.length > limit ? String(items.at(-1)!.id) : null, row => String(row.id));
}
export function getCareerRecord(kind: CareerRecordKind, id: number, page: ContextPageInput) {
  return inTransaction(() => {
    const db = getDb(), record = db.prepare(`SELECT * FROM ${specs[kind].table} WHERE id=?`).get(id);
    if (!record) throw new McpOperationError("NOT_FOUND", "求职工具记录不存在");
    const related = kind === "resume_defense" ? db.prepare("SELECT * FROM resume_defense_drills WHERE defense_id=? ORDER BY id").all(id) :
      kind === "salary_negotiation" ? db.prepare("SELECT * FROM salary_negotiation_turns WHERE negotiation_id=? ORDER BY turn_no,id").all(id) : [];
    return mcpContextPage({ kind, record, related }, page);
  });
}
