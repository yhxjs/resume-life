import type { DatabaseSync } from "node:sqlite";

/** 将现有错题的投递归属独立保存，源模拟面试删除后依旧可回顾。 */
export function linkApplicationNotebooks(db: DatabaseSync, applicationId: number) {
  db.prepare(`INSERT OR IGNORE INTO application_preparation_resources (application_id, notebook_id)
    SELECT a.id, n.id FROM applications a
    JOIN notebook_entries n ON n.source = 'interview'
    JOIN interview_turns t ON t.id = n.source_id JOIN interviews i ON i.id = t.interview_id
    WHERE a.id = ? AND (a.interview_id = i.id OR a.interview_series_id = i.series_id OR EXISTS (
      SELECT 1 FROM application_preparation_resources p WHERE p.application_id = a.id AND (p.interview_id = i.id OR p.series_id = i.series_id)
    ))`).run(applicationId);
}
