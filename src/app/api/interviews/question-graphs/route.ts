import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCursorPage, encodeUpdatedAtCursor, parsePaginationParams } from "@/lib/cursor-pagination";

async function handleGet(req: Request) {
  const pagination = parsePaginationParams(new URL(req.url).searchParams, "updatedAt");
  if (!pagination.ok) return pagination.response;
  const { limit, updatedAtCursor } = pagination;
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (updatedAtCursor) {
    conditions.push("(g.updated_at < ? OR (g.updated_at = ? AND g.id < ?))");
    params.push(updatedAtCursor.updatedAt, updatedAtCursor.updatedAt, updatedAtCursor.id);
  }
  params.push(limit + 1);

  const db = getDb();
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM interview_question_graphs").get() as { total: number };
  const rows = db.prepare(
    `SELECT g.id, g.resume_id, g.resume_version_id, g.jd, g.style, g.question, g.revision, g.created_at, g.updated_at,
            COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title
     FROM interview_question_graphs g
     JOIN resumes r ON r.id = g.resume_id
     LEFT JOIN resume_versions rv ON rv.id = g.resume_version_id
     ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY g.updated_at DESC, g.id DESC
     LIMIT ?`,
  ).all(...params) as {
    id: number;
    resume_id: number;
    resume_version_id: number | null;
    jd: string;
    style: string;
    question: string;
    revision: number;
    created_at: string;
    updated_at: string;
    resume_title: string;
  }[];
  const page = createCursorPage(rows, limit, (row) => encodeUpdatedAtCursor({ updatedAt: row.updated_at, id: row.id }));
  return NextResponse.json({ ...page, total });
}

export const GET = withRouteErrorHandling("GET /api/interviews/question-graphs", handleGet);
