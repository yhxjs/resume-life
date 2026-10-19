import { escapeLike, getDb } from "@/lib/db";

import { createCursorPage } from "@/lib/cursor-pagination";

export function listDrills(projectId: number, q: string, cursor: number | null, limit: number) {

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (Number.isInteger(projectId) && projectId > 0) {
    conditions.push("d.project_id = ?");
    params.push(projectId);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      `(p.name LIKE ? ESCAPE '\\' OR d.direction LIKE ? ESCAPE '\\' OR d.jd LIKE ? ESCAPE '\\' OR d.focus LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM drill_questions dq
         WHERE dq.drill_id = d.id
           AND (dq.question LIKE ? ESCAPE '\\' OR dq.answer LIKE ? ESCAPE '\\')))`
    );
    params.push(like, like, like, like, like, like);
  }
  if (cursor !== null) {
    conditions.push("d.id < ?");
    params.push(cursor);
  }
  params.push(limit + 1);

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT d.id, d.source, d.direction, d.jd, d.focus, d.created_at, p.name AS project_name,
              COUNT(q.id) AS total,
              SUM(CASE WHEN q.answered_at != '' THEN 1 ELSE 0 END) AS answered
       FROM drills d
       LEFT JOIN projects p ON p.id = d.project_id
       LEFT JOIN drill_questions q ON q.drill_id = d.id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       GROUP BY d.id
       ORDER BY d.id DESC
       LIMIT ?`
    )
    .all(...params) as {
    id: number;
    source: string;
    direction: string;
    jd: string;
    created_at: string;
    project_name: string | null;
    total: number;
    answered: number;
  }[];

  return createCursorPage(rows, limit, (row) => String(row.id));

}
