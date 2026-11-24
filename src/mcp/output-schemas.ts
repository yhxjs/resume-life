import * as z from "zod/v4";
import { MCP_ERROR_CODES } from "@/lib/mcp-errors";
import { APPLICATION_STAGES, INTERVIEW_ROUND_STATUSES } from "@/lib/applications-types";
import { PLAN_STEP_KEYS } from "@/lib/preparation-plan-types";

// Restore preserves historical IDs across the full safe-integer range.
const id = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const jsonObject = z.record(z.string(), z.json());
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).catchall(z.json());
const record = object({ id });
const fullContent = object({ tool: z.literal("read_record_section"), kind: z.string(), id });
const task = object({ id, title: z.string(), done: z.boolean(), due_time: z.string(), created_at: z.string() });
const round = object({ id, application_id: id, round_name: z.string(), interview_time: z.string(), status: z.enum(INTERVIEW_ROUND_STATUSES) });
export const applicationDataSchema = object({
  id, company: z.string(), role: z.string(), stage: z.enum(APPLICATION_STAGES), revision,
  jd: z.string(), notes: z.string(), created_at: z.string(), updated_at: z.string(),
  interviews: z.array(round).optional(), preparation_tasks: z.array(task).optional(),
});
export const preparationPlanDataSchema = object({
  application: applicationDataSchema, contextKey: revision, revision,
  generatedAt: z.string().nullable(), stale: z.boolean(),
  steps: z.array(object({ key: z.enum(PLAN_STEP_KEYS), title: z.string(), done: z.boolean(), manual: z.boolean(), blocked: z.string().nullable() })),
});
export const generationDataSchema = object({
  draftId: id, applicationId: id, kind: z.enum(["jd", "diagnosis", "review"]), sourceRevision: revision,
  company: z.string(), role: z.string(), result: jsonObject, saved: z.boolean(), expiresAt: z.string(), fullContent,
  idempotencyKey: z.string(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable(),
});
export const draftDataSchema = object({
  id, kind: z.enum(["jd", "diagnosis", "review"]), application_id: id, interview_id: id.nullable(),
  source_revision: revision, payload: z.string(), created_at: z.string(), expires_at: z.string(), fullContent,
  idempotencyKey: z.string().nullable(), expired: z.boolean(), saved: z.boolean(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable(),
});
const page = (item: z.ZodType = record) => object({ items: z.array(item), nextCursor: z.string().nullable() });

const core: Record<string, z.ZodType> = {
  get_application: object({ application: applicationDataSchema, submissionContent: fullContent.nullable(), interviewRounds: z.array(round), history: z.array(jsonObject), customTasks: z.array(task) }),
  list_applications: page(applicationDataSchema),
  get_preparation_plan: preparationPlanDataSchema,
  read_record_section: object({ kind: z.string(), id, revision, encoding: z.literal("json/utf-16"), offset: z.number().int().nonnegative(), text: z.string(), totalLength: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() }),
  create_application: record, create_preparation_task: record, schedule_application_interview: record,
  update_preparation_task: record, reschedule_application_interview: record, save_application_interview_questions: record,
  get_application_interview_questions: object({ applicationId: id, interviewId: id, roundName: z.string(), revision, inputHash: revision.nullable(), materialError: z.string().nullable(),
    questions: z.array(object({ question: z.string(), answer: z.string(), stuck: z.string(), feedback: z.string() })), fullContent }),
  analyze_application_jd: generationDataSchema, diagnose_application_resume: generationDataSchema, draft_interview_review: generationDataSchema,
  get_ai_draft: draftDataSchema,
  list_ai_drafts: page(object({ id, kind: z.enum(["jd", "diagnosis", "review"]), application_id: id, interview_id: id.nullable(), source_revision: revision,
    idempotencyKey: z.string().nullable(), created_at: z.string(), expires_at: z.string(), expired: z.boolean(), saved: z.boolean(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable() })),
  get_ai_generation_request: object({ idempotencyKey: z.string(), kind: z.enum(["jd", "diagnosis", "review"]), applicationId: id, interviewId: id.nullable(), sourceRevision: revision,
    status: z.enum(["pending", "succeeded", "failed", "interrupted", "invalidated"]), draftId: id.nullable(), draftAvailable: z.boolean(), expiresAt: z.string().nullable(),
    saved: z.boolean(), savedRecord: object({ id, kind: z.enum(["jd", "diagnosis", "review"]) }).nullable(), errorCode: z.enum(MCP_ERROR_CODES).nullable(), createdAt: z.string(), updatedAt: z.string() }),
  save_ai_draft: object({ id, draftId: id, applicationId: id, kind: z.enum(["jd", "diagnosis", "review"]), saved: z.literal(true) }),
  list_preparation_tasks: page(task), list_application_interviews: page(round),
  list_mcp_operations: page(object({ id, request_id: z.string(), tool: z.string(), target_id: id.nullable(), status: z.enum(["success", "error"]), error_code: z.enum(MCP_ERROR_CODES).nullable(), duration_ms: z.number().int().nonnegative(), created_at: z.string() })),
};

/** Keep every legacy business field while describing the fields clients use to page, write and recover. */
export function toolOutputSchema(name: string, permits: (name: string) => boolean) {
  const data = name === "update_application" ? (permits("get_application") ? applicationDataSchema : record)
    : name === "set_preparation_step" ? (permits("get_preparation_plan") ? preparationPlanDataSchema : object({ applicationId: id, key: z.enum(PLAN_STEP_KEYS), done: z.boolean() }))
      : name === "generate_preparation_plan" ? (permits("get_preparation_plan") ? preparationPlanDataSchema : object({ applicationId: id, generated: z.literal(true) }))
      : core[name] ?? (name.startsWith("list_") ? page() : jsonObject);
  return z.object({
    ok: z.boolean(), data: data.optional(),
    error: z.object({ code: z.enum(MCP_ERROR_CODES), message: z.string(), retryable: z.boolean() }).optional(),
    meta: z.object({ requestId: z.uuid(), durationMs: z.number().int().nonnegative() }),
  });
}
