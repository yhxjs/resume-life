import { getDb, inTransaction } from "./db";
import type { ResumeStyleOverrides } from "./templates";

/** Callers normalize layout and check revisions inside their outer transaction. */
export function writeResumeLayout(resumeId: number, input: { removeKeys?: string[]; moduleOrder?: string[]; template?: string; styleOverrides?: ResumeStyleOverrides; at: string }) {
  return inTransaction(() => {
    const db = getDb();
    for (const key of input.removeKeys ?? []) db.prepare("DELETE FROM resume_modules WHERE resume_id=? AND module_key=?").run(resumeId, key);
    input.moduleOrder?.forEach((key, sort) => db.prepare("UPDATE resume_modules SET sort=?,updated_at=? WHERE resume_id=? AND module_key=?").run(sort, input.at, resumeId, key));
    if (input.template !== undefined) db.prepare("UPDATE resumes SET template=? WHERE id=?").run(input.template, resumeId);
    if (input.styleOverrides !== undefined) db.prepare("UPDATE resumes SET style_overrides=? WHERE id=?").run(JSON.stringify(input.styleOverrides), resumeId);
    db.prepare("UPDATE resumes SET updated_at=? WHERE id=?").run(input.at, resumeId);
  });
}
