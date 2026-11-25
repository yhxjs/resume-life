import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";
import { escapeLike, getDb } from "@/lib/db";
import { safeScores } from "@/lib/scores";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { getReviewMastery } from "@/lib/spaced-repetition";
import { createNotebookFavorite, NotebookMutationError } from "@/lib/notebook-storage";
import { ApplicationInputError } from "@/lib/applications";

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
  const categoryId = categoryParam === null ? null : categoryParam === "0" ? 0 : parseCanonicalPositiveId(categoryParam);
  const source = url.searchParams.get("source") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim();
  if (categoryId !== null && categoryParam !== "0" && (!Number.isSafeInteger(categoryId) || categoryId <= 0)) {
    return NextResponse.json({ error: "无效的分类筛选" }, { status: 400 });
  }
  if (source !== "" && source !== "drill" && source !== "interview" && source !== "application_interview") {
    return NextResponse.json({ error: "无效的来源筛选" }, { status: 400 });
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (categoryParam === "0") {
    // 约定 0 表示「未分类」
    conditions.push("e.category_id IS NULL");
  } else if (categoryId !== null) {
    conditions.push("e.category_id = ?");
    params.push(categoryId);
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
  const parsed = await parseApiJson<unknown>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as { source?: unknown; source_id?: unknown; category_id?: unknown } | null;
  try {
    return NextResponse.json(createNotebookFavorite({ source: body?.source, sourceId: body?.source_id, categoryId: body?.category_id }), { status: 201 });
  } catch (error) {
    if (error instanceof ApplicationInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof NotebookMutationError) return NextResponse.json({ error: error.message }, { status: error.status });
    const requestId = logServerError("notebook.create", error, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json({ error: "收藏题目失败，请稍后重试", requestId }, { status: 500 });
  }
}

export const GET = withRouteErrorHandling("GET /api/notebook", handleGet);
export const POST = withRouteErrorHandling("POST /api/notebook", handlePost);
