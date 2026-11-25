import { getDb, inTransaction } from "./db";

/** Callers validate the affected revisions inside this transaction before writing normalized content. */
export function writeResumeDraftContent(resumeId: number, input: { title?: string; updates: { key: string; content: string }[]; at: string }) {
  return inTransaction(() => {
    const db = getDb();
    if (input.title !== undefined) db.prepare("UPDATE resumes SET title=?,updated_at=? WHERE id=?").run(input.title, input.at, resumeId);
    const update = db.prepare("UPDATE resume_modules SET content=?,updated_at=? WHERE resume_id=? AND module_key=?");
    for (const entry of input.updates) update.run(entry.content, input.at, resumeId, entry.key);
    if (input.updates.length) db.prepare("UPDATE resumes SET updated_at=? WHERE id=?").run(input.at, resumeId);
  });
}
