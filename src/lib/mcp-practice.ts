import { getDb } from "./db";
import { captureDrillGrade, commitDrillGrade } from "./drill-grading";
import { drillEvaluationRules, validateDrillEvaluation } from "./drill-answer-llm";
import { MAX_DRILL_QUESTIONS } from "./drills-questions";
import { createDrillRecord } from "./drill-store";
import { hasQuestionContent, questionComparisonKey } from "./question-normalization";
import { McpOperationError } from "./mcp-errors";
import { fitPage, pageParams, type PageInput } from "./mcp-read";
import { mcpRevision } from "./mcp-revision";
import { mcpCreateOnce } from "./mcp-state";

export type GradeAccess = NonNullable<Parameters<typeof captureDrillGrade>[2]>;
function gradeBasis(id: number, authorize: GradeAccess) {
  const snapshot = captureDrillGrade(id, undefined, authorize);
  const rules = drillEvaluationRules(snapshot);
  const scoringRules = rules.systemPrompt + rules.contextRules;
  return { snapshot, scoringRules, revision: mcpRevision("drill-grade", { snapshot, scoringRules }) };
}

export function readPracticeAnswerContext(id: number, authorize: GradeAccess) {
  const { snapshot, revision, scoringRules } = gradeBasis(id, authorize);
  const { drill, question, projectContext } = snapshot;
  return { id, revision, drillId: drill.id, source: drill.source, direction: drill.direction, jd: drill.jd,
    question: question.question, answeredAt: question.answered_at, projectContext, scoringRules };
}

export function submitPracticeAnswer(input: { questionId: number; answer: string; evaluation: object; expectedRevision: string; idempotencyKey: string }, authorize: GradeAccess) {
  const { idempotencyKey, ...payload } = input;
  const result = validateDrillEvaluation(input.evaluation);
  if (!result) throw new McpOperationError("INVALID_ARGUMENT", "点评需要四项 0–10 整数评分、有效点评和参考答案");
  return mcpCreateOnce("submit_practice_answer", idempotencyKey, { ...payload, evaluation: result }, () => {
    const { snapshot, revision } = gradeBasis(input.questionId, authorize);
    if (revision !== input.expectedRevision) throw new McpOperationError("CONFLICT", "题目、原答或评分依据已变化，请重新读取");
    return commitDrillGrade(snapshot, input.answer, result);
  }, id => !!getDb().prepare("SELECT 1 FROM drill_questions WHERE id=?").get(id));
}

type BankEntry = { id: number; direction: string; kind: "tech" | "behavior"; question: string; created_at: string };
const bankSelect = "SELECT id,direction,kind,question,created_at FROM bank_entries";
export function readBankEntry(id: number) {
  return getDb().prepare(`${bankSelect} WHERE id=?`).get(id) as BankEntry | undefined;
}

export function listBankEntries(input: PageInput & { direction?: string; kind?: BankEntry["kind"] }) {
  const { idCursor, limit } = pageParams(input);
  const rows = getDb().prepare(`${bankSelect} WHERE (? IS NULL OR id<?) AND (? IS NULL OR direction=?) AND (? IS NULL OR kind=?) ORDER BY id DESC LIMIT ?`)
    .all(idCursor, idCursor, input.direction ?? null, input.direction ?? null, input.kind ?? null, input.kind ?? null, limit + 1) as BankEntry[];
  const items = rows.slice(0, limit).map(row => ({ ...row, revision: mcpRevision("bank-entry", row), fullContent: { tool: "read_record_section", kind: "bank_entry", id: row.id } }));
  return fitPage(items, rows.length > limit ? String(items.at(-1)!.id) : null, row => String(row.id));
}

export function listNotebookCategories(input: PageInput) {
  const { idCursor, limit } = pageParams(input);
  const rows = getDb().prepare("SELECT id,name FROM notebook_categories WHERE (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?").all(idCursor, idCursor, limit + 1) as { id: number; name: string }[];
  return fitPage(rows.slice(0, limit), rows.length > limit ? String(rows[limit - 1]!.id) : null, row => String(row.id));
}

export function createSelectedPractice(input: { entries: { id: number; revision: string }[]; jd: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("create_practice_session", idempotencyKey, payload, () => {
    if (!input.entries.length || input.entries.length > MAX_DRILL_QUESTIONS) throw new McpOperationError("INVALID_ARGUMENT", "请核对题量");
    const entries = input.entries.map(item => {
      const row = readBankEntry(item.id);
      if (!row || mcpRevision("bank-entry", row) !== item.revision) throw new McpOperationError("CONFLICT", "所选题库条目已变化或删除，请重新选题");
      return row;
    });
    if (entries.some(row => !hasQuestionContent(row.question))) throw new McpOperationError("INVALID_ARGUMENT", "所选题库条目缺少有效题干，请重新选题");
    if (new Set(entries.map(row => questionComparisonKey(row.question))).size !== entries.length) throw new McpOperationError("INVALID_ARGUMENT", "所选题目不能重复");
    const direction = [...new Set(entries.map(row => row.direction).filter(Boolean))].join("、");
    const id = createDrillRecord({ source: "bank", direction, jd: input.jd, questions: entries });
    return { id };
  }, id => !!getDb().prepare("SELECT 1 FROM drills WHERE id=?").get(id));
}
