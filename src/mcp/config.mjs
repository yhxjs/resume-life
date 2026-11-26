/** Capability policy shared by doctor, the stdio handshake and tools/call. No DB or SDK imports. */
export const toolAccess = Object.freeze({
  search_records_page: "read",
  get_repository_evidence_diff: "read", preview_repository_evidence_update: "read", save_repository_evidence_update: "write",
  list_repository_evidence_history: "read", get_repository_evidence_version: "read",
  get_resume_template_context: "read", create_resume_template: "write", preview_resume_template: "read", save_resume_template: "write", get_resume_avatar_context: "read", set_resume_avatar: "write",
  begin_mcp_upload: "write", append_mcp_upload: "write", complete_mcp_upload: "write", get_mcp_upload: "read",
  extract_uploaded_file: "write", get_file_extraction: "read", get_file_import_context: "read", submit_file_import: "write", preview_file_import: "read", save_file_import: "write",
  start_mcp_job: "write", get_mcp_job: "read", list_mcp_jobs: "read", get_mcp_job_result: "read", cancel_mcp_job: "write",
  preview_mcp_cache_cleanup: "read", cleanup_mcp_cache: "write",
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
  get_intro_generation_context: "read", save_generated_intro: "write", save_intro_comments: "write",
  get_project_summary_context: "read", preview_project_summary: "read", save_project_summary: "write", list_project_summary_history: "read",
  get_practice_generation_context: "read", save_generated_practice: "write",
  list_intros: "read", list_jd_portraits: "read", list_interview_series: "read", list_bank_directions: "read",
  get_interview_training_context: "read", save_interview_training_result: "write",
  get_interview_series_context: "read", save_interview_series_result: "write", get_series_interview_state: "read", answer_series_interview: "write", finish_series_interview: "write",
  get_resume_draft_context: "read", create_resume_draft: "write", preview_resume_draft_edit: "read", save_resume_draft_edit: "write",
  list_career_records: "read", get_career_record: "read", get_career_workflow_context: "read", save_career_result: "write",
  get_diagnosis_adoption_context: "read", preview_diagnosis_adoption: "read", save_diagnosis_adoption: "write",
  get_resume_layout_context: "read", preview_resume_layout: "read", save_resume_layout: "write",
  get_resume_export_context: "read", export_resume: "write", read_export_artifact: "read",
  preview_bank_import: "read", save_bank_import: "write", get_bank_import_result: "read", get_notebook_organization_context: "read",
  create_notebook_category: "write", rename_notebook_category: "write", move_notebook_entry: "write",
  get_project_material_context: "read", preview_project_material_edit: "read", save_project_material_edit: "write",
  get_repository_catalog: "read", capture_project_repository: "write", get_repository_capture: "read", save_repository_evidence: "write",
  get_jargon_generation_context: "read", save_jargon_result: "write", get_portfolio_sources: "read", get_portfolio_context: "read", export_portfolio: "write",
  get_workflow_catalog: "read",
  get_resume_version_context: "read", compare_resume_versions: "read", publish_resume_version: "write", preview_resume_version_branch: "read", branch_resume_version: "write",
});

export const MCP_SERVER_VERSION = "1.5.0";

const reads = Object.keys(toolAccess).filter(name => toolAccess[name] === "read");
const preparationWrites = ["create_application", "update_application", "generate_preparation_plan", "set_preparation_step",
  "create_preparation_task", "update_preparation_task", "schedule_application_interview", "reschedule_application_interview",
  "update_application_interview", "save_application_interview_questions", "set_preparation_resource"];
const preset = (tools, writeEnabled) => Object.freeze({ tools: Object.freeze(tools), writeEnabled, llmEnabled: false });
const commonReads = ["get_workflow_catalog", "search_records", "get_mcp_status", "read_record_section", "list_mcp_operations", "list_resumes", "get_resume", "list_resume_versions",
  "search_records_page",
  "get_mcp_job", "list_mcp_jobs", "get_mcp_job_result", "preview_mcp_cache_cleanup",
  "list_projects", "get_project", "list_project_materials"];
const trainingTools = [...commonReads,
  "get_jargon_generation_context", "save_jargon_result",
  "preview_bank_import", "save_bank_import", "get_bank_import_result", "get_notebook_organization_context", "create_notebook_category", "rename_notebook_category", "move_notebook_entry",
  "list_bank_directions", "list_bank_entries", "list_practice_sessions", "list_practice_questions", "get_practice_question", "get_practice_answer_context", "get_practice_generation_context",
  "list_notebook_categories", "list_notebook", "get_notebook_entry", "list_review_cards", "get_review_card", "get_review_submission",
  "list_interviews", "get_interview", "get_mock_interview_state", "get_interview_training_context", "list_interview_series", "get_interview_series", "get_interview_series_context", "get_series_interview_state",
  "list_career_records", "get_career_record", "get_career_workflow_context",
  "create_practice_session", "save_generated_practice", "submit_practice_answer", "bookmark_practice_question", "save_notebook_note", "submit_review",
  "start_mock_interview", "answer_mock_interview", "finish_mock_interview", "save_interview_training_result",
  "save_interview_series_result", "answer_series_interview", "finish_series_interview", "save_career_result"];
const authoringTools = [...commonReads,
  "get_repository_evidence_diff", "preview_repository_evidence_update", "save_repository_evidence_update", "list_repository_evidence_history", "get_repository_evidence_version",
  "get_resume_template_context", "create_resume_template", "preview_resume_template", "save_resume_template", "get_resume_avatar_context", "set_resume_avatar",
  "begin_mcp_upload", "append_mcp_upload", "complete_mcp_upload", "get_mcp_upload", "extract_uploaded_file", "get_file_extraction", "get_file_import_context", "submit_file_import", "preview_file_import", "save_file_import",
  "start_mcp_job", "cancel_mcp_job",
  "get_portfolio_sources", "get_portfolio_context", "export_portfolio", "get_jargon_generation_context", "save_jargon_result", "list_career_records", "get_career_record",
  "get_project_material_context", "preview_project_material_edit", "save_project_material_edit", "get_repository_catalog", "capture_project_repository", "get_repository_capture", "save_repository_evidence",
  "get_resume_export_context", "export_resume", "read_export_artifact",
  "get_resume_layout_context", "preview_resume_layout", "save_resume_layout",
  "get_diagnosis_adoption_context", "preview_diagnosis_adoption", "save_diagnosis_adoption", "get_resume_version_context", "compare_resume_versions", "publish_resume_version", "preview_resume_version_branch", "branch_resume_version",
  "list_intros", "get_intro", "get_intro_generation_context", "preview_intro_edit", "get_project_summary_context", "preview_project_summary", "list_project_summary_history",
  "get_resume_draft_context", "preview_resume_draft_edit", "list_jd_portraits", "get_jd_portrait", "list_resume_diagnoses", "get_resume_diagnosis",
  "list_applications", "get_application", "list_application_preparation_resources", "get_ai_workflow_context", "get_ai_draft", "list_ai_drafts", "get_ai_generation_request",
  "get_interview_review", "list_interview_reviews", "get_application_interview_questions",
  "create_project", "add_project_material", "save_project_summary", "save_generated_intro", "save_intro_comments", "save_intro_edit",
  "create_resume_draft", "save_resume_draft_edit", "submit_ai_draft", "save_ai_draft"];

/** Named presets generate concrete allowlists. External-model collaboration does not enable server model calls. */
export const mcpPresets = Object.freeze({
  readonly: preset(reads, false),
  preparation: preset([...reads.filter(name => !["get_ai_workflow_context", "get_ai_draft", "list_ai_drafts", "get_ai_generation_request"].includes(name)), ...preparationWrites], true),
  collaboration: preset([...reads, ...Object.keys(toolAccess).filter(name => toolAccess[name] === "write")], true),
  training: preset(trainingTools, true),
  authoring: preset(authoringTools, true),
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
