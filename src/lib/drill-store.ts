import { getDb, inTransaction, now } from "./db";
import { insertQuestions } from "./drills-questions";

/** Question snapshots and their session always commit together, for Web and MCP alike. */
export function createDrillRecord(input: { source: "project" | "bank" | "interview"; projectId?: number; interviewId?: number;
  direction?: string; jd?: string; focus?: string; questions: { question: string; kind: string }[] }) {
  return inTransaction(() => {
    const id = Number(getDb().prepare("INSERT INTO drills (source,project_id,interview_id,direction,jd,focus,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(input.source, input.projectId ?? null, input.interviewId ?? null, input.direction ?? "", input.jd ?? "", input.focus ?? "", now()).lastInsertRowid);
    insertQuestions(id, input.questions);
    return id;
  });
}
