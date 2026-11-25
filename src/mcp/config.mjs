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
  list_application_preparation_resources: "read", list_resume_diagnoses: "read", get_resume_diagnosis: "read", get_jd_portrait: "read", get_intro: "read", get_interview_series: "read",
  get_ai_workflow_context: "read", list_review_cards: "read", get_review_card: "read", get_review_submission: "read", get_mcp_status: "read",
  set_preparation_resource: "write", update_application_interview: "write", submit_ai_draft: "write",
  bookmark_practice_question: "write", save_notebook_note: "write", submit_review: "write", maintain_mcp_state: "write",
  list_bank_entries: "read", list_notebook_categories: "read", get_practice_answer_context: "read",
  create_practice_session: "write", submit_practice_answer: "write",
  preview_intro_edit: "read", save_intro_edit: "write", create_project: "write", add_project_material: "write",
  get_mock_interview_state: "read", start_mock_interview: "write", answer_mock_interview: "write", finish_mock_interview: "write",
});

export const MCP_SERVER_VERSION = "1.2.0";

const reads = Object.keys(toolAccess).filter(name => toolAccess[name] === "read");
const preparationWrites = ["create_application", "update_application", "generate_preparation_plan", "set_preparation_step",
  "create_preparation_task", "update_preparation_task", "schedule_application_interview", "reschedule_application_interview",
  "update_application_interview", "save_application_interview_questions", "set_preparation_resource"];
const preset = (tools, writeEnabled) => Object.freeze({ tools: Object.freeze(tools), writeEnabled, llmEnabled: false });

/** Named presets generate concrete allowlists. External-model collaboration does not enable server model calls. */
export const mcpPresets = Object.freeze({
  readonly: preset(reads, false),
  preparation: preset([...reads.filter(name => !["get_ai_workflow_context", "get_ai_draft", "list_ai_drafts", "get_ai_generation_request"].includes(name)), ...preparationWrites], true),
  collaboration: preset([...reads, ...Object.keys(toolAccess).filter(name => toolAccess[name] === "write")], true),
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
