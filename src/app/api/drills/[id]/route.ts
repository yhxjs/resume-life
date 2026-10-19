import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { safeScores } from "@/lib/scores";
import { getReviewMastery } from "@/lib/spaced-repetition";

type DrillRow = {
  id: number;
  source: string;
  project_id: number | null;
  direction: string;
  jd: string;
  interview_id: number | null;
  focus: string;
  created_at: string;
};
type QuestionRow = {
  id: number;
  idx: number;
  question: string;
  answer: string;
  comment: string;
  reference: string;
  scores: string;
  answered_at: string;
  kind: string;
  notebook_id: number | null;
  review_card_id: number | null;
  next_review_date: string | null;
  review_count: number;
  repetitions: number;
  interval_days: number;
};

function loadDrill(id: number) {
  const db = getDb();
  const drill = db
    .prepare(
      `SELECT d.id, d.source, d.project_id, d.direction, d.jd, d.interview_id, d.focus, d.created_at, p.name AS project_name
       FROM drills d LEFT JOIN projects p ON p.id = d.project_id WHERE d.id = ?`
    )
    .get(id) as (DrillRow & { project_name: string | null }) | undefined;
  if (!drill) return null;
  const rows = db
    .prepare(
      `SELECT dq.id, dq.idx, dq.question, dq.answer, dq.comment, dq.reference, dq.scores, dq.answered_at, dq.kind,
              ne.id AS notebook_id, rc.id AS review_card_id, rc.next_review_date,
              rc.review_count, rc.repetitions, rc.interval_days
       FROM drill_questions dq
       LEFT JOIN notebook_entries ne ON ne.source = 'drill' AND ne.source_id = dq.id
       LEFT JOIN review_cards rc ON rc.drill_question_id = dq.id OR rc.notebook_id = ne.id
       WHERE dq.drill_id = ?
       ORDER BY dq.idx`
    )
    .all(id) as QuestionRow[];
  const questions = rows.map((q) => ({
    ...q,
    scores: safeScores(q.scores),
    review_mastery: q.review_card_id ? getReviewMastery(q) : null,
  }));
  return { ...drill, questions };
}

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drillId = Number(id);
  if (!Number.isInteger(drillId)) {
    return NextResponse.json({ error: "无效的练习 ID" }, { status: 400 });
  }
  const data = loadDrill(drillId);
  if (!data) return NextResponse.json({ error: "练习不存在" }, { status: 404 });
  return NextResponse.json(data);
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drillId = Number(id);
  if (!Number.isInteger(drillId)) {
    return NextResponse.json({ error: "无效的练习 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => {
    clearEntityLlmLabels(db, "drill", drillId);
    return db.prepare("DELETE FROM drills WHERE id = ?").run(drillId);
  });
  if (result.changes === 0) return NextResponse.json({ error: "练习不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const GET = withRouteErrorHandling("GET /api/drills/[id]", handleGet);
export const DELETE = withRouteErrorHandling("DELETE /api/drills/[id]", handleDelete);
