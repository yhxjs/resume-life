import type { DatabaseSync } from "node:sqlite";
import type { EntityType } from "./llm-source";

/** 在调用方的删除事务内、外键级联前擦除标题；匿名计量继续保留。 */
export function clearEntityLlmLabels(db: DatabaseSync, type: EntityType, id: number): void {
  db.prepare("UPDATE llm_call_logs SET entity_label = '' WHERE entity_type = ? AND entity_id = ?").run(type, id);
  if (type === "resume") {
    db.prepare(`UPDATE llm_call_logs SET entity_label = ''
      WHERE (entity_type = 'interview' AND entity_id IN (
        SELECT id FROM interviews WHERE resume_id = ?
          OR series_id IN (SELECT id FROM interview_series WHERE resume_id = ?)
      )) OR (entity_type = 'interview_series' AND entity_id IN (
        SELECT id FROM interview_series WHERE resume_id = ?
      )) OR (entity_type = 'intro' AND entity_id IN (
        SELECT id FROM intros WHERE resume_id = ?
      ))`).run(id, id, id, id);
  } else if (type === "interview_series") {
    db.prepare(`UPDATE llm_call_logs SET entity_label = ''
      WHERE entity_type = 'interview' AND entity_id IN (SELECT id FROM interviews WHERE series_id = ?)`)
      .run(id);
  } else if (type === "project") {
    db.prepare(`UPDATE llm_call_logs SET entity_label = ''
      WHERE entity_type = 'drill' AND entity_id IN (SELECT id FROM drills WHERE project_id = ?)`)
      .run(id);
  }
}
