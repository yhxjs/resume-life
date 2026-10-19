import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { dataGeneration, getDb, inTransaction, now } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { loadProjectContext } from "@/lib/projects";
import { safeChat, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";
import { normalizeScores } from "@/lib/scores";
import { errorMessage } from "@/lib/error-message";
import { enrollRemedialReview } from "@/lib/spaced-repetition-enrollment";
import { syncNotebookSnapshot } from "@/lib/notebook";

const PROJECT_EVAL_PROMPT = `你是严格的面试官。候选人针对项目面试题提交了书面回答，请评分。
输出 JSON：
{
  "depth": 0-10 整数,
  "structure": 0-10 整数,
  "authenticity": 0-10 整数,
  "completeness": 0-10 整数,
  "comment": "综合点评，2-4 句中文，指出优点与不足",
  "reference": "改进版参考答案：一段完整、结构化的示范作答"
}
维度定义：depth 技术深度（是否讲清原理与取舍）；structure 结构表达（STAR 完整性与条理）；authenticity 真实性（与项目档案的一致性，发现编造或含糊其辞给低分并在点评中说明）；completeness 完整度（是否覆盖问题要点）。
评分要拉开差距：空泛作答不超过 4 分。只输出 JSON。`;

const BANK_EVAL_PROMPT = `你是严格的面试官。候选人针对岗位通用面试题（八股题或行为题）提交了书面回答，请评分。
输出 JSON：
{
  "depth": 0-10 整数,
  "structure": 0-10 整数,
  "authenticity": 0-10 整数,
  "completeness": 0-10 整数,
  "comment": "综合点评，2-4 句中文，指出优点与不足",
  "reference": "参考答案：八股题给出准确、结构化的标准答案要点；行为题给出一段完整的 STAR 示范作答"
}
维度定义：depth 技术深度（八股题：是否讲清原理与要点；行为题：事例是否具体、有细节与反思）；structure 结构表达（条理与完整叙述，行为题看 STAR 完整性）；authenticity 真实性（回答是否具体可信，编造、含糊、套话空话给低分并在点评中说明）；completeness 完整度（是否覆盖问题要点）。
评分要拉开差距：空泛作答不超过 4 分。只输出 JSON。`;

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string; qid: string }> }
) {
  const { id, qid } = await params;
  const drillId = Number(id);
  const questionId = Number(qid);
  if (!Number.isInteger(drillId) || !Number.isInteger(questionId)) {
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
  const drill = db
    .prepare("SELECT source, project_id, direction, jd FROM drills WHERE id = ?")
    .get(drillId) as
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

  // 项目题带项目档案评分；题库题没有项目档案，用方向/JD 作背景
  const isBankDrill = drill.source === "bank" || drill.project_id === null;
  const systemPrompt = isBankDrill ? BANK_EVAL_PROMPT : PROJECT_EVAL_PROMPT;
  const contextParts: PromptPart[] = isBankDrill
    ? [
        { trust: "trusted", text: "【岗位背景】\n" },
        ...(drill.direction
          ? [
              { trust: "trusted", text: "方向：" } as const,
              { trust: "untrusted", tag: "job_direction", text: drill.direction } as const,
            ]
          : []),
        ...(drill.direction && drill.jd ? [{ trust: "trusted", text: "\n" } as const] : []),
        ...(drill.jd
          ? [
              { trust: "trusted", text: "JD：" } as const,
              { trust: "untrusted", tag: "job_description", text: drill.jd } as const,
            ]
          : []),
        ...(!drill.direction && !drill.jd
          ? [{ trust: "trusted", text: "（未提供）" } as const]
          : []),
      ]
    : [
        { trust: "trusted", text: "【项目档案】\n" },
        {
          trust: "untrusted",
          tag: "project_context",
          text: await loadProjectContext(drill.project_id!),
        },
      ];

  let raw: string;
  try {
    raw = await safeChat("evaluate", { feature: LLM_FEATURES.drillGrade, entity: { type: "drill", id: drillId } }, systemPrompt, [
      {
        role: "user",
        parts: [
          ...contextParts,
          { trust: "trusted", text: "\n\n【面试题】\n" },
          { trust: "untrusted", tag: "interview_question", text: question.question },
          { trust: "trusted", text: "\n\n【候选人回答】\n" },
          { trust: "untrusted", tag: "candidate_answer", text: answer },
        ],
      },
    ], { signal: req.signal, requireJson: true });
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson<Record<string, unknown>>(raw);
  } catch (err) {
    return NextResponse.json(
      { error: `AI 评分结果异常：${errorMessage(err)}` },
      { status: 502 }
    );
  }
  const scores = normalizeScores(parsed);
  if (!scores) {
    return NextResponse.json({ error: "AI 评分缺少有效维度分，请重试" }, { status: 502 });
  }
  if (typeof parsed.comment !== "string" || !parsed.comment.trim()
    || typeof parsed.reference !== "string" || !parsed.reference.trim()) {
    return NextResponse.json({ error: "AI 评分缺少有效点评或参考答案，请重试" }, { status: 502 });
  }
  const comment = parsed.comment;
  const reference = parsed.reference;

  const committed = inTransaction(() => {
    if (dataGeneration(db) !== generation) return "conflict";
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
    return NextResponse.json({ error: committed === "missing" ? "题目已删除" : "题目已发生变化，请刷新后重新评分" },
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
