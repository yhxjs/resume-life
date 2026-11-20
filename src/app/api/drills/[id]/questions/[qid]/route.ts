import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { dataGeneration, getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { loadProjectContext, projectContextMatches, ProjectNotFoundError } from "@/lib/projects";
import { ProjectSummaryCorruptError } from "@/lib/summary";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { enrollRemedialReview } from "@/lib/spaced-repetition-enrollment";
import { syncNotebookSnapshot } from "@/lib/notebook";
import { buildDrillEvaluation, validateDrillEvaluation } from "@/lib/drill-answer-llm";
import { validateGeneratedScores } from "@/lib/scores";

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string; qid: string }> }
) {
  const { id, qid } = await params;
  const drillId = parseCanonicalPositiveId(id);
  const questionId = parseCanonicalPositiveId(qid);
  if (!Number.isSafeInteger(drillId) || drillId <= 0 || !Number.isSafeInteger(questionId) || questionId <= 0) {
    return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { answer?: unknown } | null;
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (!answer) {
    return NextResponse.json({ error: "回答内容不能为空" }, { status: 400 });
  }

  const db = getDb();
  const generation = dataGeneration(db);
  const drillQuery = db.prepare(`SELECT d.source, d.project_id, d.direction,
      CASE WHEN d.source = 'interview' AND d.jd = '' THEN COALESCE(i.jd, '') ELSE d.jd END AS jd
      FROM drills d LEFT JOIN interviews i ON d.source = 'interview' AND i.id = d.interview_id
      WHERE d.id = ?`);
  const drill = drillQuery.get(drillId) as
    | { source: string; project_id: number | null; direction: string; jd: string }
    | undefined;
  const question = db
    .prepare("SELECT idx, question, answer, comment, reference, scores, answered_at, kind FROM drill_questions WHERE id = ? AND drill_id = ?")
    .get(questionId, drillId) as {
      idx: number; question: string; answer: string; comment: string; reference: string;
      scores: string; answered_at: string; kind: string;
    } | undefined;
  if (!drill || !question) {
    return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  }

  // 追练使用创建时的 JD 快照；旧追练缺少快照时仅回退到关联面试，不修改历史记录。
  // 项目题带项目档案评分；题库题与追练用方向/JD 作背景。
  const isBankDrill = drill.source === "bank" || drill.project_id === null;
  const usesEvidenceSnapshot = drill.source === "project" && question.kind === "evidence";
  let projectContext = "";
  try {
    if (usesEvidenceSnapshot) projectContext = "本题仅使用题干保存的依据快照与条件；未提供完整项目档案，不能据此推断全文缺失或个人职责。";
    else if (!isBankDrill) projectContext = await loadProjectContext(drill.project_id!);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ProjectSummaryCorruptError) return NextResponse.json({ error: err.message }, { status: 422 });
    if (!(err instanceof ModelInputBudgetError)) throw err;
    return NextResponse.json({ error: err.message }, { status: 413 });
  }
  let raw: string;
  try {
    const prompt = buildDrillEvaluation({ isBankDrill, direction: drill.direction, jd: drill.jd, projectContext, question: question.question, answer });
    raw = await safeChat("evaluate", { feature: LLM_FEATURES.drillGrade, entity: { type: "drill", id: drillId } }, prompt.systemPrompt, prompt.messages, { signal: req.signal, requireJson: "strict" });
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return NextResponse.json(
      { error: `AI 评分结果异常：${errorMessage(err)}` },
      { status: 502 }
    );
  }
  if (!validateGeneratedScores(parsed)) {
    return NextResponse.json({ error: "AI 评分分数必须是 0-10 整数，请重试" }, { status: 502 });
  }
  const result = validateDrillEvaluation(parsed);
  if (!result) return NextResponse.json({ error: "AI 评分结构、分数、点评或参考答案无效，请重试" }, { status: 502 });
  const { scores, comment, reference } = result;

  const committed = inTransaction(() => {
    if (dataGeneration(db) !== generation) return "conflict";
    const currentDrill = drillQuery.get(drillId);
    if (!currentDrill) return "missing";
    if (JSON.stringify(currentDrill) !== JSON.stringify(drill)
      || (!isBankDrill && !usesEvidenceSnapshot && !projectContextMatches(drill.project_id!, projectContext))) return "context-conflict";
    const result = db.prepare(
      `UPDATE drill_questions SET answer = ?, comment = ?, reference = ?, scores = ?, answered_at = ?
       WHERE id = ? AND drill_id = ? AND idx = ? AND question = ? AND answer = ?
         AND comment = ? AND reference = ? AND scores = ? AND answered_at = ? AND kind = ?`
    ).run(answer, comment, reference, JSON.stringify(scores), now(), questionId, drillId,
      question.idx, question.question, question.answer, question.comment, question.reference,
      question.scores, question.answered_at, question.kind);
    if (result.changes === 1) {
      enrollRemedialReview(db, questionId);
      syncNotebookSnapshot(db, "drill", questionId, {
        answer,
        comment,
        reference,
        scores: JSON.stringify(scores),
      });
      return "saved";
    }
    return db.prepare("SELECT id FROM drill_questions WHERE id = ? AND drill_id = ?").get(questionId, drillId)
      ? "conflict" : "missing";
  });
  if (committed !== "saved") {
    return NextResponse.json({ error: committed === "missing" ? "题目已删除"
      : committed === "context-conflict" ? "评分背景已发生变化，请刷新后重新评分"
      : "题目已发生变化，请刷新后重新评分" },
      { status: committed === "missing" ? 404 : 409 });
  }

  return NextResponse.json({
    question_id: questionId,
    scores,
    comment,
    reference,
  });
}

export const POST = withRouteErrorHandling("POST /api/drills/[id]/questions/[qid]", handlePost);
