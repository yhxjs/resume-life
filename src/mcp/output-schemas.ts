import * as z from "zod/v4";
import { MCP_ERROR_CODES } from "@/lib/mcp-errors";
import { APPLICATION_STAGES, INTERVIEW_ROUND_STATUSES } from "@/lib/applications-types";
import { PLAN_STEP_KEYS } from "@/lib/preparation-plan-types";
import { PREPARATION_KINDS } from "@/lib/application-preparation-types";
import { INTRO_KINDS } from "@/lib/intro";
import { CAREER_RECORD_KINDS } from "@/lib/mcp-career";

// Restore preserves historical IDs across the full safe-integer range.
const id = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.json());
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).catchall(z.json());
const record = object({ id });
const count = z.number().int().nonnegative();
const fullContent = object({ tool: z.literal("read_record_section"), kind: z.string(), id,
  workflowKind: z.enum(["jd", "diagnosis", "review"]).optional(), interviewId: id.optional(), requestId: z.uuid().optional(), timeZone: z.string().max(100).optional() });
const task = object({ id, title: z.string(), done: z.boolean(), due_time: z.string(), created_at: z.string() });
const round = object({ id, application_id: id, round_name: z.string(), interview_time: z.string(), status: z.enum(INTERVIEW_ROUND_STATUSES),
  interviewer: z.string().optional(), location: z.string().optional(), meeting_url: z.string().optional(), reminder_minutes: count.optional(),
  notes: z.string().optional(), created_at: z.string().optional(), updated_at: z.string().optional() });
const version = object({ id, version: z.number().int(), parent_id: id.nullable(), name: z.string(), description: z.string(), created_at: z.string() });
const interview = object({ id, resume_id: id, resume_title: z.string(), resume_version_id: id.nullable(), resume_version: z.number().int().nullable(),
  jd: z.string(), rounds: z.number().int(), style: z.string(), series_id: id.nullable(), round_no: z.number().int(), status: z.string(),
  report: z.json(), evaluator_report: z.json(), turn_count: count, created_at: z.string(), finished_at: z.string() });
const answerFields = { question: z.string(), answer: z.string(), comment: z.string(), reference: z.string() };
const turn = object({ id, idx: z.number().int(), kind: z.string(), ...answerFields, scores: z.json(), answered_at: z.string() });
const notebookNote = object({ id, notebook_id: id, content: z.string(), created_at: z.string(), updated_at: z.string() });
const reviewLink = object({ review_card_id: id, review_mastery: z.enum(["new", "relearning", "learning", "familiar", "mastered"]), next_review_date: z.string() });
const reviewCard = object({ id, source: z.enum(["notebook", "remedial"]), source_id: id, source_label: z.string(), question: z.string(),
  mastery: z.enum(["new", "relearning", "learning", "familiar", "mastered"]), interval_days: count, ease_factor: count, repetitions: count, review_count: count,
  lapses: count, next_review_date: z.string(), last_reviewed_at: z.string(), sort_date: z.string().optional() });
const reviewAttempt = object({ id, answer: z.string(), grade: z.enum(["again", "hard", "good", "easy"]), reviewed_at: z.string(), interval_days: count, next_review_date: z.string() });
const reviewSummary = object({ date: z.string(), total: count, due: count, notebook: count, remedial: count, overdue: count, completed_today: count });
const portraitResult = object({ role: z.string(), mustSkills: z.array(object({ name: z.string(), weight: z.number().int(), why: z.string() })),
  followups: z.array(object({ topic: z.string(), questions: z.array(z.string()) })), companyStyle: object({ style: z.string(), signals: z.array(z.string()) }) });
const diagnosisResult = object({ match: z.number(), summary: z.string(), modules: z.array(object({ moduleKey: z.string(), label: z.string(),
  scores: object({ depth: z.number(), structure: z.number(), authenticity: z.number(), completeness: z.number() }), gaps: z.string(),
  suggestions: z.array(object({ itemId: z.string(), field: z.enum(["description", "text", "items"]), reason: z.string(), draft: z.union([z.string(), z.array(z.string())]) })) })) });
const reviewResult = object({ mistakes: z.array(object({ question_index: z.number().int(), gap: z.string(), improved_answer: z.string() })),
  drills: z.array(object({ question_index: z.number().int(), question: z.string() })), resume_suggestions: z.array(object({ question_index: z.number().int(), suggestion: z.string() })) });
const stageCounts = z.object(Object.fromEntries(APPLICATION_STAGES.map(stage => [stage, count])));
const funnel = object({ counts: stageCounts, totalApplications: count, totalActive: count, totalCompleted: count, totalOffers: count, totalRejected: count,
  winRate: z.number(), overallYieldRate: z.number(), unknownTerminations: count, incompleteHistoryCount: count,
  steps: z.array(object({ stage: z.enum(APPLICATION_STAGES), label: z.string(), desc: z.string(), count, cumulativeCount: count, passedCount: count,
    unknownCount: count, conversionRate: z.number().nullable(), dropOffCount: count, dropOffRate: z.number().nullable() })),
  hiringSteps: z.array(object({ stage: z.string(), label: z.string(), active: count, passed: count, terminated: count, conversionRate: z.number().nullable() })),
  insights: z.array(object({ id: z.string(), severity: z.enum(["info", "warning", "success"]), title: z.string(), description: z.string(), metricHighlight: z.string() })) });
export const applicationDataSchema = object({
  id, company: z.string(), role: z.string(), stage: z.enum(APPLICATION_STAGES), revision,
  jd: z.string(), notes: z.string(), created_at: z.string(), updated_at: z.string(),
  interviews: z.array(round).optional(), preparation_tasks: z.array(task).optional(),
  resume_id: id.nullable().optional(), resume_version_id: id.nullable().optional(), resume_title: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(), next_interview_at: z.string().optional(), salary_range: z.string().optional(),
});
export const preparationPlanDataSchema = object({
  application: applicationDataSchema, contextKey: revision, revision,
  generatedAt: z.string().nullable(), stale: z.boolean(),
  steps: z.array(object({ key: z.enum(PLAN_STEP_KEYS), title: z.string(), done: z.boolean(), manual: z.boolean(), blocked: z.string().nullable() })),
});
const generationFields = {
  draftId: id, applicationId: id, sourceRevision: revision,
  company: z.string(), role: z.string(), saved: z.boolean(), expiresAt: z.string(), fullContent,
  idempotencyKey: z.string(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable(),
};
export const generationDataSchema = z.discriminatedUnion("kind", [
  object({ ...generationFields, kind: z.literal("jd"), result: portraitResult }),
  object({ ...generationFields, kind: z.literal("diagnosis"), result: diagnosisResult }),
  object({ ...generationFields, kind: z.literal("review"), result: reviewResult }),
]);
export const draftDataSchema = object({
  id, kind: z.enum(["jd", "diagnosis", "review"]), application_id: id, interview_id: id.nullable(),
  source_revision: revision, payload: z.string(), created_at: z.string(), expires_at: z.string(), fullContent,
  idempotencyKey: z.string().nullable(), expired: z.boolean(), saved: z.boolean(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable(),
});
const page = (item: z.ZodType = record) => object({ items: z.array(item), nextCursor: z.string().nullable() });
const contextSection = object({ revision, encoding: z.literal("json/utf-16"), offset: count, text: z.string(), totalLength: count, nextOffset: count.nullable() });

const artifactSchema = object({ artifactId: revision, filename: z.string(), mimeType: z.string(), byteLength: count, sha256: revision,
  sourceRevision: revision, createdAt: z.string(), read: object({ tool: z.literal("read_export_artifact"), artifactId: revision, offset: count }) });
const searchEntry = object({ id, title: z.string(), created_at: z.string(), fullContent: object({ tool: z.string(), id, kind: z.string().optional() }) });
const core: Record<string, z.ZodType> = {
  get_workflow_catalog: contextSection,
  get_jargon_generation_context: contextSection, save_jargon_result: record, get_portfolio_sources: contextSection, get_portfolio_context: contextSection, export_portfolio: artifactSchema,
  get_project_material_context: contextSection, preview_project_material_edit: contextSection.extend({ previewToken: revision }), save_project_material_edit: record,
  get_repository_catalog: contextSection, get_repository_capture: contextSection,
  capture_project_repository: record.extend({ fileCount: count, capturedAt: z.string(), capture: object({ tool: z.literal("get_repository_capture"), idempotencyKey: z.string() }) }),
  save_repository_evidence: record.extend({ materialIds: z.array(id) }),
  preview_bank_import: contextSection.extend({ previewToken: revision }), get_bank_import_result: contextSection,
  save_bank_import: record.extend({ createdCount: count, skippedCount: count, result: object({ tool: z.literal("get_bank_import_result"), idempotencyKey: z.string() }) }),
  get_notebook_organization_context: contextSection, create_notebook_category: record, rename_notebook_category: record, move_notebook_entry: record,
  get_resume_export_context: contextSection,
  export_resume: artifactSchema,
  read_export_artifact: artifactSchema.extend({ encoding: z.literal("base64"), offset: count, data: z.string(), nextOffset: count.nullable() }),
  get_resume_layout_context: contextSection, preview_resume_layout: contextSection.extend({ previewToken: revision }), save_resume_layout: record,
  get_diagnosis_adoption_context: contextSection, preview_diagnosis_adoption: contextSection.extend({ previewToken: revision }), save_diagnosis_adoption: record,
  get_resume_version_context: contextSection, compare_resume_versions: contextSection, publish_resume_version: record,
  preview_resume_version_branch: contextSection.extend({ previewToken: revision }), branch_resume_version: record,
  get_intro_generation_context: contextSection, get_project_summary_context: contextSection,
  get_practice_generation_context: contextSection, save_generated_practice: record,
  get_interview_training_context: contextSection, save_interview_training_result: record,
  get_interview_series_context: contextSection, save_interview_series_result: record, answer_series_interview: record, finish_series_interview: record,
  get_resume_draft_context: contextSection, create_resume_draft: record, preview_resume_draft_edit: contextSection.extend({ previewToken: revision }), save_resume_draft_edit: record,
  get_career_record: contextSection, get_career_workflow_context: contextSection, save_career_result: record,
  list_career_records: page(object({ id, title: z.string(), created_at: z.string(), kind: z.enum(CAREER_RECORD_KINDS),
    fullContent: object({ tool: z.literal("get_career_record"), kind: z.enum(CAREER_RECORD_KINDS), id }) })),
  get_series_interview_state: object({ id, revision, resumeId: id, versionId: id.nullable(), status: z.enum(["ongoing", "finished"]), rounds: z.number().int(),
    answered: count, currentTurnId: id.nullable(), currentIndex: z.number().int().nullable(), reportSaved: z.boolean() }),
  list_intros: page(object({ id, resume_id: id, resume_version_id: id.nullable(), jd: z.string(), created_at: z.string(), resume_title: z.string(), fullContent })),
  list_jd_portraits: page(object({ id, jd: z.string(), created_at: z.string(), fullContent })),
  list_interview_series: page(object({ id, resume_id: id, resume_version_id: id.nullable(), jd: z.string(), rounds: count, status: z.string(), created_at: z.string(), finished_at: z.string(), fullContent })),
  list_bank_directions: page(object({ id, direction: z.string(), count })),
  preview_project_summary: contextSection.extend({ previewToken: revision }),
  save_generated_intro: record, save_intro_comments: record, save_project_summary: record,
  list_project_summary_history: page(object({ id, source: z.enum(["ai", "repo", "manual"]), createdAt: z.string(), fullContent })),
  list_bank_entries: page(object({ id, direction: z.string(), kind: z.enum(["tech", "behavior"]), question: z.string(), created_at: z.string(), revision, fullContent })),
  list_notebook_categories: page(object({ id, name: z.string() })),
  get_practice_answer_context: object({ id, drillId: id, source: z.string(), question: z.string(), answeredAt: z.string(), revision,
    direction: z.string(), jd: z.string(), projectContext: z.string(), scoringRules: z.string(), fullContent }),
  preview_intro_edit: object({ id, kind: z.enum(INTRO_KINDS), revision, previewToken: revision, changeCount: count, nextCursor: z.string().nullable(),
    changes: z.array(object({ line: count, before: z.string().nullable(), after: z.string().nullable() })) }),
  get_mock_interview_state: object({ id, revision, resumeId: id, versionId: id.nullable(), status: z.enum(["ongoing", "finished"]), rounds: z.number().int(),
    answered: count, currentTurnId: id.nullable(), currentIndex: z.number().int().nullable(), reportSaved: z.boolean() }),
  create_practice_session: record, submit_practice_answer: record, save_intro_edit: record, create_project: record, add_project_material: record,
  start_mock_interview: record, answer_mock_interview: record, finish_mock_interview: record,
  search_records: object({ query: z.string(), resumes: z.array(object({ id, title: z.string(), updated_at: z.string() })),
    projects: z.array(object({ id, name: z.string(), summary_updated_at: z.string(), updated_at: z.string() })),
    applications: z.array(object({ id, company: z.string(), role: z.string(), stage: z.enum(APPLICATION_STAGES), updated_at: z.string() })),
    interviews: z.array(object({ id, resume_id: id, resume_title: z.string(), resume_version_id: id.nullable(), resume_version: z.number().int().nullable(),
      series_id: id.nullable(), round_no: z.number().int(), status: z.string(), style: z.string(), created_at: z.string(), finished_at: z.string() })),
    practiceSessions: z.array(object({ id, source: z.string(), direction: z.string(), focus: z.string(), created_at: z.string(), project_name: z.string().nullable() })),
    intros: z.array(searchEntry), jdPortraits: z.array(searchEntry), interviewSeries: z.array(searchEntry), careerRecords: z.array(searchEntry), bankEntries: z.array(searchEntry), notebookEntries: z.array(searchEntry) }),
  list_resumes: page(object({ id, title: z.string(), created_at: z.string(), updated_at: z.string(), versions: z.array(version), versionCount: count, versionsTruncated: z.boolean() })),
  get_resume: object({ resume: object({ id, revision, title: z.string(), template: z.string(), created_at: z.string(), updated_at: z.string(), version_id: id.nullable() }),
    modules: z.array(object({ key: z.string(), type: z.string(), label: z.string(), content: z.string() })), warnings: z.array(z.json()),
    base_version_id: id.nullable(), versions: z.array(version), versionCount: count, versionsTruncated: z.boolean() }),
  list_projects: page(object({ id, name: z.string(), summary_updated_at: z.string(), updated_at: z.string(), material_count: count })),
  get_project: object({ project: object({ id, revision, name: z.string(), summary: z.json(), summary_updated_at: z.string(), created_at: z.string(), updated_at: z.string(), summaryWarning: z.string().nullable() }),
    materialCount: count, hasMoreMaterials: z.boolean(), materials: z.array(object({ id, title: z.string(), source: z.string(), filename: z.string(), content: z.string(), created_at: z.string() })) }),
  list_interviews: page(interview), get_interview: object({ interview, turns: z.array(turn), nextCursor: z.string().nullable(), hasMoreTurns: z.boolean() }),
  list_interview_reviews: page(object({ id, interview_id: id, application_id: id, company: z.string().nullable(), role: z.string().nullable(), round_name: z.string().nullable(),
    jd: z.string().nullable(), questions: z.json(), result: z.json(), created_at: z.string() })),
  get_interview_review: object({ id, interview_id: id, application_id: id, input_hash: z.string(), company: z.string().nullable(), role: z.string().nullable(), round_name: z.string().nullable(),
    jd: z.string().nullable(), questions: z.string(), result: z.string(), created_at: z.string(), fullContent }),
  list_practice_questions: page(object({ id, drill_id: id, idx: z.number().int(), ...answerFields, scores: z.json(), answered_at: z.string(), kind: z.string(),
    source: z.string(), direction: z.string(), focus: z.string(), project_name: z.string().nullable(), created_at: z.string() })),
  get_practice_question: object({ id, drill_id: id, idx: z.number().int(), kind: z.string(), ...answerFields, scores: z.string(), answered_at: z.string(), fullContent }),
  list_practice_sessions: page(object({ id, source: z.string(), direction: z.string(), jd: z.string(), focus: z.string(), created_at: z.string(), project_name: z.string().nullable(),
    total: count, answered: count, fullContent })),
  list_notebook: page(object({ id, category_id: id.nullable(), category_name: z.string().nullable(), source: z.string(), source_label: z.string(), ...answerFields,
    scores: z.json(), created_at: z.string(), updated_at: z.string() })),
  get_notebook_entry: object({ id, category_id: id.nullable(), source: z.string(), source_id: id, source_label: z.string(), ...answerFields, scores: z.string(),
    created_at: z.string(), updated_at: z.string(), fullContent, note: notebookNote.nullable(), noteRevision: revision, review: reviewLink.nullable() }),
  list_project_materials: page(object({ id, project_id: id, title: z.string(), contentLength: count, created_at: z.string() })),
  list_resume_versions: page(version.extend({ resume_id: id })),
  list_application_history: page(object({ id, application_id: id, from_stage: z.enum(APPLICATION_STAGES).nullable(), to_stage: z.enum(APPLICATION_STAGES),
    from_hiring_stage: z.string().nullable(), to_hiring_stage: z.string().nullable(), terminal_stage: z.string().nullable(), changed_at: z.string(), reason: z.string() })),
  get_today_priorities: object({ date: z.string(), items: z.array(object({ id: z.string(), kind: z.enum(["interview", "materials", "review"]), title: z.string(),
    reason: z.string(), badge: z.string(), urgent: z.boolean(), href: z.string(), action: z.string() })) }),
  get_application_stats: object({ counts: stageCounts, totalActive: count, rates: object({ appliedRate: z.number(), interviewRate: z.number(), offerRate: z.number() }),
    funnel, batchStats: z.array(funnel.extend({ batchName: z.string() })), upcomingInterviews: z.array(object({ id, company: z.string(), role: z.string(), round_name: z.string().nullable(), next_interview_at: z.string() })) }),
  get_application: object({ application: applicationDataSchema, submissionContent: fullContent.nullable(), interviewRounds: z.array(round), history: z.array(jsonObject), customTasks: z.array(task) }),
  list_applications: page(applicationDataSchema),
  get_preparation_plan: preparationPlanDataSchema,
  read_record_section: object({ kind: z.string(), id, revision, encoding: z.literal("json/utf-16"), offset: z.number().int().nonnegative(), text: z.string(), totalLength: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() }),
  create_application: record, create_preparation_task: record, schedule_application_interview: record,
  update_preparation_task: record, reschedule_application_interview: record, update_application_interview: record, save_application_interview_questions: record,
  get_application_interview_questions: object({ applicationId: id, interviewId: id, roundName: z.string(), revision, inputHash: revision.nullable(), materialError: z.string().nullable(),
    questions: z.array(object({ question: z.string(), answer: z.string(), stuck: z.string(), feedback: z.string() })), fullContent }),
  analyze_application_jd: generationDataSchema, diagnose_application_resume: generationDataSchema, draft_interview_review: generationDataSchema, submit_ai_draft: generationDataSchema,
  get_ai_draft: draftDataSchema,
  list_ai_drafts: page(object({ id, kind: z.enum(["jd", "diagnosis", "review"]), application_id: id, interview_id: id.nullable(), source_revision: revision,
    idempotencyKey: z.string().nullable(), created_at: z.string(), expires_at: z.string(), expired: z.boolean(), saved: z.boolean(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable() })),
  get_ai_generation_request: object({ idempotencyKey: z.string(), kind: z.enum(["jd", "diagnosis", "review"]), applicationId: id, interviewId: id.nullable(), sourceRevision: revision,
    status: z.enum(["pending", "succeeded", "failed", "interrupted", "invalidated"]), draftId: id.nullable(), draftAvailable: z.boolean(), expiresAt: z.string().nullable(),
    saved: z.boolean(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable(), errorCode: z.enum(MCP_ERROR_CODES).nullable(), createdAt: z.string(), updatedAt: z.string(),
    origin: z.enum(["server", "external"]), phase: z.enum(["generating", "validating", "ready", "saved", "expired", "unavailable", "failed", "interrupted", "invalidated"]), phaseUpdatedAt: z.string() }),
  save_ai_draft: object({ id, draftId: id, applicationId: id, kind: z.enum(["jd", "diagnosis", "review"]), saved: z.literal(true) }),
  list_preparation_tasks: page(task), list_application_interviews: page(round),
  list_mcp_operations: page(object({ id, request_id: z.string(), tool: z.string(), target_id: id.nullable(), status: z.enum(["success", "error"]), error_code: z.enum(MCP_ERROR_CODES).nullable(), duration_ms: z.number().int().nonnegative(), created_at: z.string() })),
  list_application_preparation_resources: object({ applicationId: id, kind: z.enum(PREPARATION_KINDS), candidates: z.boolean(), revision, total: count,
    items: z.array(object({ id, title: z.string(), summary: z.string(), created_at: z.string(), resume_id: id.nullable(), linked: z.boolean(), href: z.string().nullable(), fullContent })), nextCursor: z.string().nullable() }),
  set_preparation_resource: object({ applicationId: id, kind: z.enum(PREPARATION_KINDS), resourceId: id, linked: z.boolean() }),
  list_resume_diagnoses: page(object({ id, resume_id: id, resume_version_id: id.nullable(), job_id: z.string(), job_title: z.string(), created_at: z.string(), match: z.number().nullable(), fullContent })),
  get_resume_diagnosis: object({ id, resume_id: id, resume_version_id: id.nullable(), job_id: z.string(), job_title: z.string(), jd: z.string(),
    report: diagnosisResult.nullable(), resume_snapshot: object({ title: z.string(), modules: z.array(object({ key: z.string(), type: z.string(), label: z.string(), sort: z.number(), content: z.json() })) }),
    adoptions: z.array(jsonObject), created_at: z.string(), corruptedFields: z.array(z.string()).optional(),
    raw_fields: object({ report: z.string().optional(), resume_snapshot: z.string().optional(), adoptions: z.string().optional() }).optional(), fullContent }),
  get_jd_portrait: object({ id, jd: z.string(), result: portraitResult.nullable(), created_at: z.string(),
    read_error: z.string().optional(), raw_result: z.string().optional(), fullContent }),
  get_intro: object({ id, resume_id: id, resume_version_id: id.nullable(), jd: z.string(), created_at: z.string(), resume_title: z.string(),
    resume_version: z.number().nullable(), resume_version_name: z.string().nullable(), versions: z.array(object({ kind: z.enum(INTRO_KINDS),
      sentences: z.array(object({ text: z.string(), comment: z.string() })), revision, read_error: z.string().optional(), raw_sentences: z.string().optional() })), fullContent }),
  get_interview_series: object({ id, resume_id: id, resume_version_id: id.nullable(), jd: z.string(), rounds: z.number().int(), status: z.string(), final_report: z.string(),
    created_at: z.string(), finished_at: z.string(), interviews: z.array(object({ id, series_id: id, round_no: z.number().int(), status: z.string(), style: z.string(), created_at: z.string(), finished_at: z.string() })), fullContent }),
  get_ai_workflow_context: object({ kind: z.enum(["jd", "diagnosis", "review"]), applicationId: id, interviewId: id.nullable(), sourceRevision: revision,
    context: object({ application: object({ id, company: z.string(), role: z.string(), jd: z.string(), resume_id: id.nullable(), resume_version_id: id.nullable() }),
      resume: jsonObject.optional(), diagnosisModules: z.array(z.json()).optional(), review: jsonObject.optional() }), resultSchema: jsonObject, outputInstructions: z.string(), fullContent }),
  list_review_cards: page(reviewCard).extend({ summary: reviewSummary }),
  get_review_card: reviewCard.extend({ answer: z.string(), comment: z.string(), reference: z.string(), attempts: z.array(reviewAttempt.extend({ fullContent })), nextCursor: z.string().nullable(), fullContent }),
  get_review_submission: object({ request_id: z.string(), card: reviewCard, attempt: reviewAttempt, fullContent }),
  submit_review: object({ id, cardId: id, requestId: z.uuid() }), bookmark_practice_question: record, save_notebook_note: record,
  get_mcp_status: object({ serverVersion: z.string(), databaseVersion: count, enabledTools: z.array(z.string()),
    drafts: object({ total: count, available: count, expired: count }), generationRequests: object({ pending: count, interrupted: count, succeeded: count, failed: count }), operationLogCount: count }),
  maintain_mcp_state: object({ removedDrafts: count, clearedResponses: count }),
};

/** Keep every legacy business field while describing the fields clients use to page, write and recover. */
export function toolOutputSchema(name: string, permits: (name: string) => boolean) {
  const data = name === "update_application" ? (permits("get_application") ? applicationDataSchema : record)
    : name === "set_preparation_step" ? (permits("get_preparation_plan") ? preparationPlanDataSchema : object({ applicationId: id, key: z.enum(PLAN_STEP_KEYS), done: z.boolean() }))
      : name === "generate_preparation_plan" ? (permits("get_preparation_plan") ? preparationPlanDataSchema : object({ applicationId: id, generated: z.literal(true) }))
      : core[name];
  if (!data) throw new Error(`MCP 工具缺少输出契约：${name}`);
  return z.strictObject({
    ok: z.boolean(), data: data.optional(),
    error: z.object({ code: z.enum(MCP_ERROR_CODES), message: z.string(), retryable: z.boolean() }).optional(),
    meta: z.object({ requestId: z.uuid(), durationMs: z.number().int().nonnegative() }),
  }).superRefine((value, ctx) => {
    if (value.ok ? value.data === undefined || value.error !== undefined : value.error === undefined || value.data !== undefined) {
      ctx.addIssue({ code: "custom", message: "成功必须带 data 且不能带 error；失败必须带 error 且不能带 data" });
    }
  }).meta({ oneOf: [
    { properties: { ok: { const: true } }, required: ["data"], not: { required: ["error"] } },
    { properties: { ok: { const: false } }, required: ["error"], not: { required: ["data"] } },
  ] });
}
