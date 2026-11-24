/** Capability policy shared by doctor, the stdio handshake and tools/call. No DB or SDK imports. */
export const toolAccess = Object.freeze({
  search_records: "read", list_resumes: "read", get_resume: "read", list_projects: "read", get_project: "read",
  list_applications: "read", get_application: "read", get_preparation_plan: "read", list_interviews: "read", get_interview: "read",
  list_interview_reviews: "read", list_practice_questions: "read", list_practice_sessions: "read", list_notebook: "read",
  list_project_materials: "read", list_resume_versions: "read", list_application_history: "read", list_preparation_tasks: "read",
  list_application_interviews: "read", list_mcp_operations: "read", get_practice_question: "read", get_interview_review: "read",
  get_notebook_entry: "read", get_ai_draft: "read", read_record_section: "read", get_today_priorities: "read", get_application_stats: "read",
  update_application: "write", set_preparation_step: "write", create_application: "write", create_preparation_task: "write",
  schedule_application_interview: "write", save_ai_draft: "write",
  get_application_interview_questions: "read",
  list_ai_drafts: "read", get_ai_generation_request: "read",
  generate_preparation_plan: "write", update_preparation_task: "write", reschedule_application_interview: "write", save_application_interview_questions: "write",
  analyze_application_jd: "llm", diagnose_application_resume: "llm", draft_interview_review: "llm",
});

export class McpConfigurationError extends Error {}

export function permittedMcpTools(config) {
  return Object.entries(toolAccess).filter(([name, access]) =>
    (config.allowlist === null || config.allowlist.has(name)) &&
    (access === "read" || (access === "write" && config.writeEnabled) || (access === "llm" && config.llmEnabled)))
    .map(([name]) => name);
}

export function readMcpConfig(env = process.env) {
  const raw = env.RESUME_LIFE_MCP_ALLOWED_TOOLS;
  const allowlist = raw === undefined ? null : new Set(raw.split(",").map(name => name.trim()).filter(Boolean));
  if (allowlist && [...allowlist].some(name => !Object.hasOwn(toolAccess, name))) {
    throw new McpConfigurationError("RESUME_LIFE_MCP_ALLOWED_TOOLS 白名单含未知工具名，请核对配置");
  }
  const timeout = env.RESUME_LIFE_MCP_TIMEOUT_MS ?? "120000";
  if (!/^\d+$/.test(timeout) || Number(timeout) < 100 || Number(timeout) > 600_000) {
    throw new McpConfigurationError("RESUME_LIFE_MCP_TIMEOUT_MS 必须为 100–600000 毫秒");
  }
  return { allowlist, timeoutMs: Number(timeout), writeEnabled: env.RESUME_LIFE_MCP_WRITE_ENABLED === "true", llmEnabled: env.RESUME_LIFE_MCP_LLM_ENABLED === "true" };
}
