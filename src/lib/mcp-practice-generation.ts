import { getDb, inTransaction } from "./db";
import { readProjectContext } from "./projects";
import { BANK_DRILL_QUESTION_PROMPT, PROJECT_DRILL_QUESTION_PROMPT, buildProjectDrillQuestionMessages } from "./drill-question-llm";
import { REMEDIATION_PROMPT, readInterviewRemediationReport } from "./drill-remediation-llm";
import { parseQuestionItems } from "./drills-questions";
import { questionComparisonKey } from "./question-normalization";
import { createDrillRecord } from "./drill-store";
import { assertMcpContext, mcpContextPage, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpCreateOnce } from "./mcp-state";

export type PracticeGenerationSource = { kind: "project"; projectId: number; jd: string; count: number }
  | { kind: "job"; direction: string; jd: string; count: number }
  | { kind: "interview"; interviewId: number; count: number };

function capture(source: PracticeGenerationSource) {
  if (source.kind === "project") {
    const projectContext = readProjectContext(source.projectId, { maxChars: Number.MAX_SAFE_INTEGER });
    return { workflow: "practice" as const, source, rules: PROJECT_DRILL_QUESTION_PROMPT,
      messages: buildProjectDrillQuestionMessages(projectContext, source.count), untrusted: { jd: source.jd, projectContext } };
  }
  if (source.kind === "job") {
    if (!source.direction.trim() && !source.jd.trim()) throw new McpOperationError("INVALID_ARGUMENT", "岗位方向与 JD 至少提供一项");
    return { workflow: "practice" as const, source, rules: BANK_DRILL_QUESTION_PROMPT, untrusted: { jd: source.jd, direction: source.direction } };
  }
  const db = getDb();
  const interview = db.prepare("SELECT id,jd,report FROM interviews WHERE id=?").get(source.interviewId) as { id: number; jd: string; report: string } | undefined;
  if (!interview) throw new McpOperationError("NOT_FOUND", "面试不存在");
  let raw: unknown;
  try { raw = JSON.parse(interview.report); } catch { raw = null; }
  const report = readInterviewRemediationReport(raw);
  if (!report) throw new McpOperationError("INVALID_ARGUMENT", "请先保存有效的面试总结报告");
  const rows = db.prepare("SELECT idx,kind,question,answer,answered_at FROM interview_turns WHERE interview_id=? ORDER BY idx,id")
    .all(source.interviewId) as { idx: number; kind: string; question: string; answer: string; answered_at: string }[];
  return { workflow: "practice" as const, source, rules: REMEDIATION_PROMPT,
    untrusted: { jd: interview.jd, report: report.reportText, focus: report.focus,
      questions: rows.map(({ idx, kind, question }) => ({ idx, kind, question })),
      answers: rows.filter(row => row.answered_at).map(({ idx, kind, answer }) => ({ idx, kind, answer })) } };
}

export function getPracticeGenerationContext(source: PracticeGenerationSource, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(source), page));
}

export function saveGeneratedPractice(input: { source: PracticeGenerationSource; expectedRevision: string; result: unknown; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_generated_practice", idempotencyKey, payload, () => {
    const source = input.source, context = capture(source);
    assertMcpContext(context, input.expectedRevision);
    const questions = parseQuestionItems(JSON.stringify(input.result), { maxCount: source.count, project: source.kind === "project" });
    const originalQuestions = new Set((context.untrusted.questions ?? []).map(item => questionComparisonKey(item.question)));
    if (questions.some(item => originalQuestions.has(questionComparisonKey(item.question)))) throw new McpOperationError("INVALID_ARGUMENT", "追练题不能与本场原题重复");
    const id = createDrillRecord({ source: source.kind === "job" ? "bank" : source.kind,
      ...(source.kind === "project" ? { projectId: source.projectId } : source.kind === "interview" ? { interviewId: source.interviewId } : { direction: source.direction }),
      jd: context.untrusted.jd, focus: context.untrusted.focus, questions });
    return { id };
  }, id => !!getDb().prepare("SELECT 1 FROM drills WHERE id=?").get(id));
}
