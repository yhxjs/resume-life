import type { DatabaseSync } from "node:sqlite";

// A change to any input in an authorized search domain invalidates that domain's cursor.
// Fixed identifiers only; model/user input never contributes to trigger SQL.
export const MCP_SEARCH_SOURCES: Record<string, readonly string[]> = {
  application: ["applications"], resume: ["resumes", "resume_modules"], project: ["projects"],
  project_material: ["project_materials"], bank_entry: ["bank_entries"],
  practice_session: ["drills", "projects"], practice_question: ["drill_questions", "drills"], notebook: ["notebook_entries", "notebook_notes"],
  interview: ["interviews", "interview_turns", "resumes", "resume_versions"], intro: ["intros", "intro_versions", "resumes", "resume_versions"], jd_portrait: ["jd_portraits"],
  interview_series: ["interview_series"],
  resume_defense: ["resume_defenses"], career_gap_remedy: ["resignation_gap_remedies"],
  salary_negotiation: ["salary_negotiations", "salary_negotiation_turns"], jargon_decoding: ["jargon_decodings"],
};

export function createMcpSearchEpochs(db: DatabaseSync) {
  for (const [domain, tables] of Object.entries(MCP_SEARCH_SOURCES)) {
    db.prepare("INSERT OR IGNORE INTO mcp_search_epochs(domain,revision) VALUES(?,0)").run(domain);
    for (const table of tables) for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS mcp_search_epoch_${domain}_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN
          UPDATE mcp_search_epochs SET revision=revision+1 WHERE domain='${domain}';
        END;`);
    }
  }
}
