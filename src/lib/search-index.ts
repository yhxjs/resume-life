import type { DatabaseSync } from "node:sqlite";

const SOURCES = [
  { table: "applications", columns: ["company", "role", "notes", "jd"] },
  { table: "resumes", columns: ["title"] },
  { table: "resume_modules", columns: ["content"] },
  { table: "projects", columns: ["name", "summary"] },
  { table: "project_materials", columns: ["title", "content"] },
  { table: "drill_questions", columns: ["question", "answer", "comment", "reference"] },
  { table: "interviews", columns: ["jd"] },
  { table: "interview_turns", columns: ["question", "answer"] },
] as const;

export const SEARCH_INDEX_NAMES = SOURCES.map(({ table }) => `search_fts_${table}`);
export const SEARCH_INDEX_OBJECT_NAMES = new Set(
  SEARCH_INDEX_NAMES.flatMap((name) => [name, `${name}_config`, `${name}_data`, `${name}_idx`, `${name}_docsize`]),
);

export function createSearchIndexes(database: DatabaseSync): void {
  for (const { table, columns } of SOURCES) {
    const name = `search_fts_${table}`;
    const fields = columns.join(", ");
    const newValues = columns.map((column) => `new.${column}`).join(", ");
    const oldValues = columns.map((column) => `old.${column}`).join(", ");

    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${name} USING fts5(${fields}, content='${table}', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS ${name}_insert AFTER INSERT ON ${table} BEGIN
        INSERT INTO ${name}(rowid, ${fields}) VALUES (new.id, ${newValues});
      END;
      CREATE TRIGGER IF NOT EXISTS ${name}_delete AFTER DELETE ON ${table} BEGIN
        INSERT INTO ${name}(${name}, rowid, ${fields}) VALUES ('delete', old.id, ${oldValues});
      END;
      CREATE TRIGGER IF NOT EXISTS ${name}_update AFTER UPDATE ON ${table} BEGIN
        INSERT INTO ${name}(${name}, rowid, ${fields}) VALUES ('delete', old.id, ${oldValues});
        INSERT INTO ${name}(rowid, ${fields}) VALUES (new.id, ${newValues});
      END;
    `);
  }
}
