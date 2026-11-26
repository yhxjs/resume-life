import * as z from "zod/v4";
import { APPLICATION_STAGES, APPLICATION_TERMINAL_STAGES } from "./applications-types";
import { mcpResumeModuleSchema } from "./mcp-resume-contract";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const rebasePageShape = { offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), length: z.number().int().min(1).max(4000).optional(), expectedRevision: revision.optional() };
const page = z.strictObject(rebasePageShape).optional();
const choices = z.array(z.strictObject({ path: z.array(z.string().max(300)).max(30), take: z.enum(["base", "proposed", "current"]) })).max(200).default([]);
export const applicationEditFieldsSchema = z.strictObject({
  stage: z.enum(APPLICATION_STAGES).optional(), notes: z.string().max(20_000).optional(), jd: z.string().max(20_000).optional(),
  terminal_stage: z.enum(APPLICATION_TERMINAL_STAGES).optional(), terminal_reason: z.string().trim().min(1).max(1000).optional(),
  resume_id: id.nullable().optional(), resume_version_id: id.nullable().optional(),
}).refine(v => Object.keys(v).length > 0, "至少提供一个待修改字段");
// SDK 2.4 discovery expects an object schema. Conditional validation remains strict
// while every field is discoverable to Hosts without union-schema normalization.
function validateMode(input: { mode: string; expectedRevision?: string; baseToken?: string; proposed?: unknown; choices: unknown[] }, ctx: z.RefinementCtx) {
  if (input.mode === "capture" && (!input.expectedRevision || input.baseToken !== undefined || input.proposed !== undefined || input.choices.length)) ctx.addIssue({ code: "custom", message: "capture 需要 expectedRevision，不能携带 baseToken/proposed/choices" });
  if (input.mode === "rebase" && (!input.baseToken || input.proposed === undefined)) ctx.addIssue({ code: "custom", message: "rebase 需要 baseToken 和 proposed" });
}
const comparison = { mode: z.enum(["capture", "rebase"]), expectedRevision: revision.optional(), baseToken: revision.optional(), choices, page };
export const resumeRebaseInputSchema = z.strictObject({ ...comparison, resumeId: id,
  proposed: z.strictObject({ title: z.string().trim().min(1).max(200).optional(), modules: z.array(mcpResumeModuleSchema).max(30).default([]) }).optional(),
}).superRefine(validateMode);
export const applicationRebaseInputSchema = z.strictObject({ ...comparison, applicationId: id, proposed: applicationEditFieldsSchema.optional() }).superRefine(validateMode);
export const applicationEditInputSchema = z.strictObject({ applicationId: id, expectedRevision: revision, fields: applicationEditFieldsSchema });
export const applicationPreviewInputSchema = applicationEditInputSchema.extend({ page });
export const applicationSaveInputSchema = applicationEditInputSchema.extend({ previewToken: revision, idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) });
/** Data schemas: the main registrar supplies its standard ok/error/meta envelope. */
export const rebasePageOutputSchema = z.strictObject({ revision, encoding: z.literal("json/utf-16"), offset: z.number().int().nonnegative(), text: z.string(), totalLength: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() });
export const applicationPreviewOutputSchema = rebasePageOutputSchema.extend({ previewToken: revision });
export const applicationSaveOutputSchema = z.strictObject({ id });
/** Import these data-only maps from output-schemas.ts; importing rebase-tools.ts there would create a registrar cycle. */
export const REBASE_OUTPUT_SCHEMAS = {
  preview_resume_draft_rebase: rebasePageOutputSchema, preview_application_rebase: rebasePageOutputSchema,
  preview_application_edit: applicationPreviewOutputSchema, save_application_edit: applicationSaveOutputSchema,
};
export const REBASE_INPUT_SCHEMAS = {
  preview_resume_draft_rebase: resumeRebaseInputSchema, preview_application_rebase: applicationRebaseInputSchema,
  preview_application_edit: applicationPreviewInputSchema, save_application_edit: applicationSaveInputSchema,
};
export type ResumeRebaseInput = z.output<typeof resumeRebaseInputSchema>;
export type ApplicationRebaseInput = z.output<typeof applicationRebaseInputSchema>;
export type ApplicationEditInput = z.output<typeof applicationEditInputSchema>;
