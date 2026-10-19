import { withRouteErrorHandling } from "@/lib/api-route";
import { linkNotebookToApplications } from "@/lib/application-preparation";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";
import { escapeLike, getDb, inTransaction, now } from "@/lib/db";
import { safeScores } from "@/lib/scores";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { errorMessage } from "@/lib/error-message";
import { enrollNotebookReview } from "@/lib/spaced-repetition-enrollment";
import { getReviewMastery } from "@/lib/spaced-repetition";

type Snapshot = {
  question: string;
  answer: string;
  comment: string;
  reference: string;
  scores: string;
  source_label: string | null;
};

type EntryRow = {
  id: number;
  category_id: number | null;
  category_name: string | null;
  source: string;
  source_label: string;
  question: string;
  answer: string;
  comment: string;
  reference: string;
  scores: string;
  created_at: string;
  updated_at: string;
};

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const pagination = parsePaginationParams(url.searchParams);
  if (!pagination.ok) return pagination.response;
  const { limit, idCursor: cursor } = pagination;
  const categoryParam = url.searchParams.get("category_id");
  const source = url.searchParams.get("source") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim();

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (categoryParam === "0") {
    // 约定 0 表示「未分类」
    conditions.push("e.category_id IS NULL");
  } else if (categoryParam !== null) {
    const categoryId = Number(categoryParam);
    if (Number.isInteger(categoryId) && categoryId > 0) {
      conditions.push("e.category_id = ?");
      params.push(categoryId);
    }
  }
  if (source === "drill" || source === "interview" || source === "application_interview") {
    conditions.push("e.source = ?");
    params.push(source);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      `(e.question LIKE ? ESCAPE '\\' OR e.answer LIKE ? ESCAPE '\\' OR e.comment LIKE ? ESCAPE '\\')`
    );
    params.push(like, like, like);
  }

  if (cursor !== null) {
    conditions.push("e.id < ?");
    params.push(cursor);
  }
  params.push(limit + 1);

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT e.id, e.category_id, c.name AS category_name, e.source, e.source_label,
              e.question, e.answer, e.comment, e.reference, e.scores, e.created_at, e.updated_at,
              rc.id AS review_card_id, rc.next_review_date, rc.review_count, rc.repetitions, rc.interval_days
       FROM notebook_entries e
       LEFT JOIN notebook_categories c ON c.id = e.category_id
       LEFT JOIN review_cards rc ON rc.notebook_id = e.id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY e.id DESC
       LIMIT ?`
    )
    .all(...params) as (EntryRow & { review_card_id: number | null; next_review_date: string | null; review_count: number; repetitions: number; interval_days: number })[];

  const page = createCursorPage(rows, limit, (row) => String(row.id));
  return NextResponse.json({
    items: page.items.map((r) => ({ ...r, scores: safeScores(r.scores), review_mastery: r.review_card_id ? getReviewMastery(r) : null })),
    nextCursor: page.nextCursor,
  });
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    source?: unknown;
    source_id?: unknown;
    category_id?: unknown;
  } | null;
  const source = body?.source;
  const sourceId = Number(body?.source_id);
  if ((source !== "drill" && source !== "interview") || !Number.isInteger(sourceId)) {
    return NextResponse.json({ error: "无效的收藏请求" }, { status: 400 });
  }

  let categoryId: number | null = null;
  if (body?.category_id !== null && body?.category_id !== undefined) {
    categoryId = Number(body.category_id);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return NextResponse.json({ error: "无效的分类" }, { status: 400 });
    }
  }

  const db = getDb();
  if (categoryId !== null) {
    const cat = db.prepare("SELECT id FROM notebook_categories WHERE id = ?").get(categoryId);
    if (!cat) return NextResponse.json({ error: "分类不存在" }, { status: 400 });
  }

  // 收藏即快照：复制源题全部内容，源记录删除后错题本不受影响
  let snapshot: Snapshot | undefined;
  if (source === "drill") {
    snapshot = db
      .prepare(
        `SELECT dq.question, dq.answer, dq.comment, dq.reference, dq.scores,
                COALESCE(p.name, NULLIF(d.direction, ''), substr(d.jd, 1, 30), '') AS source_label
         FROM drill_questions dq
         JOIN drills d ON d.id = dq.drill_id
         LEFT JOIN projects p ON p.id = d.project_id
         WHERE dq.id = ?`
      )
      .get(sourceId) as Snapshot | undefined;
  } else {
    snapshot = db
      .prepare(
        `SELECT t.question, t.answer, t.comment, t.reference, t.scores, r.title AS source_label
         FROM interview_turns t
         JOIN interviews i ON i.id = t.interview_id
         JOIN resumes r ON r.id = i.resume_id
         WHERE t.id = ?`
      )
      .get(sourceId) as Snapshot | undefined;
  }
  if (!snapshot) {
    return NextResponse.json({ error: "原题目不存在，可能已被删除" }, { status: 404 });
  }

  const ts = now();
  try {
    return inTransaction(() => {
    const result = db
      .prepare(
        `INSERT INTO notebook_entries
           (category_id, source, source_id, source_label, question, answer, comment, reference, scores, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        categoryId,
        source,
        sourceId,
        snapshot.source_label,
        snapshot.question,
        snapshot.answer,
        snapshot.comment,
        snapshot.reference,
        snapshot.scores,
        ts,
        ts
      );
      const id = Number(result.lastInsertRowid);
      enrollNotebookReview(db, id, ts);
      if (source === "interview") linkNotebookToApplications(id, sourceId);
      return NextResponse.json({ id }, { status: 201 });
    });
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("UNIQUE")) {
      return NextResponse.json({ error: "该题已在错题本中" }, { status: 409 });
    }
    const requestId = logServerError("notebook.create", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json({ error: "收藏题目失败，请稍后重试", requestId }, { status: 500 });
  }
}

export const GET = withRouteErrorHandling("GET /api/notebook", handleGet);
export const POST = withRouteErrorHandling("POST /api/notebook", handlePost);
