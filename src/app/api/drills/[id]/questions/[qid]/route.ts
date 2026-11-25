import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { loadDrillGrade, commitDrillGrade, DrillGradeError } from "@/lib/drill-grading";
import { LlmConfigError } from "@/lib/llm";
import { ProjectNotFoundError } from "@/lib/projects";
import { ProjectSummaryCorruptError } from "@/lib/summary";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
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

  let snapshot;
  try {
    snapshot = await loadDrillGrade(questionId, drillId);
  } catch (err) {
    if (err instanceof DrillGradeError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof ProjectNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ProjectSummaryCorruptError) return NextResponse.json({ error: err.message }, { status: 422 });
    if (!(err instanceof ModelInputBudgetError)) throw err;
    return NextResponse.json({ error: err.message }, { status: 413 });
  }
  let raw: string;
  try {
    const { isBankDrill, drill, question, projectContext } = snapshot;
    const prompt = buildDrillEvaluation({ isBankDrill, direction: drill.direction, jd: drill.jd, projectContext, question: question.question, answer });
    raw = await safeChat("evaluate", { feature: LLM_FEATURES.drillGrade, entity: { type: "drill", id: drillId } }, prompt.systemPrompt, prompt.messages, {
      signal: req.signal,
      requireJson: "strict"
    });
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

  try {
    req.signal.throwIfAborted();
    commitDrillGrade(snapshot, answer, result);
  } catch (error) {
    if (error instanceof DrillGradeError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  return NextResponse.json({
    question_id: questionId,
    scores,
    comment,
    reference,
  });
}

export const POST = withRouteErrorHandling("POST /api/drills/[id]/questions/[qid]", handlePost);
