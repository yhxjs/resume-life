import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { escapeLike, getDb } from "@/lib/db";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";

/** 进阶面试列表（与单轮面试列表并列展示，客户端按创建时间合并） */
async function handleGet(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const pagination = parsePaginationParams(searchParams);
  if (!pagination.ok) return pagination.response;
  const { limit, idCursor: cursor } = pagination;
  const q = (searchParams.get("q") ?? "").trim();

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      `(s.jd LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM interviews i2
         JOIN interview_turns t2 ON t2.interview_id = i2.id
         WHERE i2.series_id = s.id
           AND (t2.question LIKE ? ESCAPE '\\' OR t2.answer LIKE ? ESCAPE '\\')))`
    );
    params.push(like, like, like, like);
  }
  if (cursor !== null) {
    conditions.push("s.id < ?");
    params.push(cursor);
  }
  params.push(limit + 1);

  const db = getDb();
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM interview_series").get() as { total: number };
  const rows = db
    .prepare(
      `SELECT s.id, s.jd, s.rounds, s.status, s.created_at, s.final_report, COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, s.resume_version_id, rv.version AS resume_version, rv.name AS resume_version_name,
              (SELECT COUNT(*) FROM interviews i WHERE i.series_id = s.id AND i.status = 'finished' AND i.report != '') AS rounds_done
       FROM interview_series s
       JOIN resumes r ON r.id = s.resume_id LEFT JOIN resume_versions rv ON rv.id = s.resume_version_id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY s.id DESC
       LIMIT ?`
    )
    .all(...params) as {
    id: number;
    jd: string;
    rounds: number;
    status: string;
    created_at: string;
    final_report: string;
    resume_title: string;
    resume_version_id: number | null;
    resume_version: number | null;
    resume_version_name: string | null;
    rounds_done: number;
  }[];

  const page = createCursorPage(rows, limit, (row) => String(row.id));
  return NextResponse.json({
    ...page,
    items: page.items.map((row) => {
      let finalOverall: number | null = null;
      if (row.final_report) {
        try {
          const value: unknown = JSON.parse(row.final_report).overall;
          const score = typeof value === "number" ? value : NaN;
          finalOverall = Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
        } catch {
          finalOverall = null;
        }
      }
      return {
        id: row.id,
        jd: row.jd,
        rounds: row.rounds,
        status: row.status,
        created_at: row.created_at,
        resume_title: row.resume_title,
        resume_version_id: row.resume_version_id,
        resume_version: row.resume_version,
        resume_version_name: row.resume_version_name,
        rounds_done: row.rounds_done,
        rounds_total: 3,
        final_overall: finalOverall,
      };
    }),
    total,
  });
}

export const GET = withRouteErrorHandling("GET /api/interviews/series", handleGet);
