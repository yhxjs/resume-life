import { dataGeneration, getDb, inTransaction, now } from "./db";
import { loadProjectContext, projectContextMatches, readProjectContext } from "./projects";
import { enrollRemedialReview } from "./spaced-repetition-enrollment";
import { syncNotebookSnapshot } from "./notebook";
import type { validateDrillEvaluation } from "./drill-answer-llm";

type Drill = { id: number; source: string; project_id: number | null; direction: string; jd: string };
type Question = { id: number; drill_id: number; idx: number; question: string; answer: string; comment: string; reference: string; scores: string; answered_at: string; kind: string };
type Grading = NonNullable<ReturnType<typeof validateDrillEvaluation>>;
export class DrillGradeError extends Error {
  constructor(message: string, readonly status: 404 | 409) { super(message); }
}

function rows(questionId: number, drillId?: number) {
  const db = getDb();
  const question = db.prepare("SELECT id, drill_id, idx, question, answer, comment, reference, scores, answered_at, kind FROM drill_questions WHERE id=?").get(questionId) as Question | undefined;
  if (!question || (drillId !== undefined && question.drill_id !== drillId)) throw new DrillGradeError("题目不存在", 404);
  const drill = db.prepare(`SELECT d.id, d.source, d.project_id, d.direction, CASE WHEN d.source='interview' AND d.jd='' THEN COALESCE(i.jd,'') ELSE d.jd END AS jd
    FROM drills d LEFT JOIN interviews i ON d.source='interview' AND i.id=d.interview_id WHERE d.id=?`).get(question.drill_id) as Drill | undefined;
  if (!drill) throw new DrillGradeError("题目不存在", 404);
  return { drill, question };
}

function gradeSource(questionId: number, drillId?: number) {
  const { drill, question } = rows(questionId, drillId);
  const isBankDrill = drill.source === "bank" || drill.project_id === null;
  const evidence = drill.source === "project" && question.kind === "evidence";
  return { generation: dataGeneration(), drill, question, isBankDrill, includesProject: !isBankDrill && !evidence,
    projectContext: evidence ? "本题仅使用题干保存的依据快照与条件；未提供完整项目档案，不能据此推断全文缺失或个人职责。" : "" };
}

/** MCP clients read the complete context in pages; their input limit is independent of the Web model. */
export function captureDrillGrade(questionId: number, drillId?: number, authorize?: (source: string, includesProject: boolean) => void) {
  return inTransaction(() => {
    const source = gradeSource(questionId, drillId);
    authorize?.(source.drill.source, source.includesProject);
    if (source.includesProject) source.projectContext = readProjectContext(source.drill.project_id!, { maxChars: Number.MAX_SAFE_INTEGER });
    return source;
  });
}

/** The Web loader may be asynchronous. Do not keep the SQLite transaction open while awaiting it. */
export async function loadDrillGrade(questionId: number, drillId: number) {
  const source = inTransaction(() => gradeSource(questionId, drillId));
  if (source.includesProject) source.projectContext = await loadProjectContext(source.drill.project_id!);
  return source;
}

export function commitDrillGrade(snapshot: ReturnType<typeof captureDrillGrade>, answer: string, grading: Grading) {
  return inTransaction(() => {
    if (snapshot.generation !== dataGeneration()) throw new DrillGradeError("数据已恢复，请刷新后重新评分", 409);
    const { question, drill } = rows(snapshot.question.id, snapshot.drill.id);
    if (JSON.stringify(drill) !== JSON.stringify(snapshot.drill) || (snapshot.includesProject && !projectContextMatches(drill.project_id!, snapshot.projectContext))) {
      throw new DrillGradeError("评分背景已发生变化，请刷新后重新评分", 409);
    }
    if (JSON.stringify(question) !== JSON.stringify(snapshot.question)) throw new DrillGradeError("题目已发生变化，请刷新后重新评分", 409);
    const db = getDb(), scores = JSON.stringify(grading.scores);
    db.prepare("UPDATE drill_questions SET answer=?, comment=?, reference=?, scores=?, answered_at=? WHERE id=?")
      .run(answer, grading.comment, grading.reference, scores, now(), question.id);
    enrollRemedialReview(db, question.id);
    syncNotebookSnapshot(db, "drill", question.id, { answer, comment: grading.comment, reference: grading.reference, scores });
    return { id: question.id };
  });
}
