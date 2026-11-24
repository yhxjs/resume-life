import { randomUUID } from "node:crypto";
import { getDb, inTransaction, now } from "./db";
import { getApplicationById, type Application } from "./applications";
import { loadResumeForModel } from "./resumes";
import { ResumeContextError } from "./resume-errors";
import { safeChat, LLM_FEATURES } from "./safe-llm";
import { JD_PORTRAIT_SYSTEM_PROMPT, buildJdPortraitMessages } from "./jd-portrait-llm";
import { validateGeneratedJdPortrait } from "./jd-portrait";
import { buildDiagnosisMessages } from "./diagnosis-llm";
import { DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT } from "./diagnosis-production-prompt";
import { sanitizeModulesForDiagnosis, validateGeneratedDiagnosis, type DiagnosisSnapshot } from "./diagnosis";
import { assertDiagnosisBudget, canArchiveDiagnosisSnapshot, findMatchingDiagnosisJob, saveDiagnosis } from "./diagnosis-history";
import { buildInterviewReviewMessages, getInterviewReviewDraftInput, InterviewReviewError, INTERVIEW_REVIEW_SYSTEM_PROMPT, parseInterviewReviewResult, saveGeneratedInterviewReview } from "./application-interview-review";
import { saveJdPortrait } from "./jd-portrait-store";
import { McpOperationError } from "./mcp-errors";
import { mcpRevision } from "./mcp-revision";
import { mcpCreateOnce } from "./mcp-state";
import { boundMcpOutput } from "./mcp-output";
import { assertOperationActive } from "./operation-deadline";
import { assertDataGeneration } from "./data-generation";

type Kind = "jd" | "diagnosis" | "review";
type Draft = { id: number; kind: Kind; application_id: number; interview_id: number | null; source_revision: string; payload: string; expires_at: string };

function source(kind: Kind, applicationId: number, interviewId?: number) {
  const application = getDb().prepare("SELECT id, company, role, jd, resume_id, resume_version_id FROM applications WHERE id = ?").get(applicationId) as
    Pick<Application, "id" | "company" | "role" | "jd" | "resume_id" | "resume_version_id"> | undefined;
  if (!application) throw new McpOperationError("NOT_FOUND", "投递记录不存在");
  if (kind !== "review" && !application.jd.trim()) throw new McpOperationError("INVALID_ARGUMENT", "该投递尚未填写 JD");
  const resume = kind === "diagnosis" && application.resume_id && application.resume_version_id
    ? loadResumeForModel(application.resume_id, application.resume_version_id) : null;
  if (kind === "diagnosis" && !resume) throw new McpOperationError("INVALID_ARGUMENT", "简历诊断需要投递绑定已发布的简历版本");
  const review = kind === "review" && interviewId ? getInterviewReviewDraftInput(applicationId, interviewId) : null;
  if (kind === "review" && !review) throw new McpOperationError("INVALID_ARGUMENT", "请提供面试轮次 ID");
  return { application, resume, review };
}

type Source = ReturnType<typeof source>;

function diagnosisSnapshot(resume: NonNullable<Source["resume"]>): DiagnosisSnapshot {
  return { title: resume.resume.title, modules: resume.modules.map(({ key, type, label, sort, content }) => ({ key, type, label, sort, content })) };
}

/** Hash the actual destination, displayed identity and model/archive inputs, not mutable board activity. */
function sourceRevision(kind: Kind, { application: a, resume, review }: Source) {
  const identity = { kind, applicationId: a.id, company: a.company, role: a.role };
  switch (kind) {
    case "jd": return mcpRevision("ai-source", { ...identity, jd: a.jd });
    case "diagnosis": return mcpRevision("ai-source", { ...identity, jd: a.jd, resumeId: a.resume_id,
      versionId: a.resume_version_id, snapshot: diagnosisSnapshot(resume!) });
    case "review": return mcpRevision("ai-source", { ...identity, interviewId: review!.context.id,
      roundName: review!.context.round_name, inputHash: review!.inputHash });
  }
}

function recheckSource(kind: Kind, applicationId: number, interviewId: number | undefined, expectedRevision: string, acceptLegacy = false) {
  const conflict = () => new McpOperationError("CONFLICT", "草稿来源已变化，请重新读取后生成");
  let current: ReturnType<typeof source>;
  try { current = source(kind, applicationId, interviewId); }
  catch (error) {
    if (error instanceof ResumeContextError || error instanceof InterviewReviewError ||
        (error instanceof McpOperationError && (error.code === "NOT_FOUND" || error.code === "INVALID_ARGUMENT"))) throw conflict();
    throw error;
  }
  if (sourceRevision(kind, current) !== expectedRevision) {
    // Already-issued 24-hour drafts can still be saved under their original (stricter) token.
    if (!acceptLegacy || mcpRevision("ai-source", { ...current, application: getApplicationById(applicationId) }) !== expectedRevision) throw conflict();
  }
  return current;
}

function diagnosisArchive(input: ReturnType<typeof source>) {
  const { application, resume } = input;
  if (!resume || !application.resume_id || !application.resume_version_id) throw new McpOperationError("INVALID_ARGUMENT", "简历诊断需要投递绑定已发布的简历版本");
  const snapshot = diagnosisSnapshot(resume);
  if (!canArchiveDiagnosisSnapshot(snapshot)) throw new McpOperationError("INVALID_ARGUMENT", "简历快照无法完整归档，请修复后重新发布");
  const job = findMatchingDiagnosisJob(application.resume_id, application.jd, application.id);
  return { id: Number.MAX_SAFE_INTEGER, resume_id: application.resume_id, resume_version_id: application.resume_version_id,
    job_id: job?.job_id || randomUUID(), job_title: job?.job_title || application.role.slice(0, 100), jd: application.jd,
    report: "", resume_snapshot: JSON.stringify(snapshot), adoptions: "[]", created_at: now() };
}

function parseModelJson(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new McpOperationError("MODEL_OUTPUT", "模型返回的内容不是有效 JSON，未保存业务资料"); }
}

function validatedResult(kind: Kind, input: ReturnType<typeof source>, raw: string) {
  if (kind === "review") {
    try { return { kind, result: parseInterviewReviewResult(raw, input.review!.questions) } as const; }
    catch { throw new McpOperationError("MODEL_OUTPUT", "模型复盘结果不符合题号、字段或内容要求，未保存业务资料"); }
  }
  const parsed = parseModelJson(raw);
  if (kind === "jd") {
    const result = validateGeneratedJdPortrait(parsed);
    if (result) return { kind, result } as const;
  } else {
    const result = validateGeneratedDiagnosis(parsed, input.resume!.modules.filter(module => module.type !== "basic"));
    if (result) return { kind, result } as const;
  }
  throw new McpOperationError("MODEL_OUTPUT", "模型结果不符合字段、长度或内容要求，未保存业务资料");
}

export async function generateMcpDraft(kind: Kind, applicationId: number, signal: AbortSignal, interviewId?: number) {
  signal.throwIfAborted();
  const input = source(kind, applicationId, interviewId);
  const revision = sourceRevision(kind, input);
  const modules = input.resume?.modules.filter(module => module.type !== "basic") ?? [];
  if (kind === "diagnosis" && !modules.length) throw new McpOperationError("INVALID_ARGUMENT", "所选简历版本没有可诊断的职业模块");
  const archive = kind === "diagnosis" ? diagnosisArchive(input) : null;
  if (archive) assertDiagnosisBudget(archive);
  assertOperationActive();
  const raw = kind === "jd"
    ? await safeChat("question", { feature: LLM_FEATURES.jdPortraitGenerate }, JD_PORTRAIT_SYSTEM_PROMPT, buildJdPortraitMessages(input.application.jd), { signal, requireJson: "strict" })
    : kind === "diagnosis"
      ? await safeChat("evaluate", { feature: LLM_FEATURES.resumeDiagnose, entity: { type: "resume", id: input.application.resume_id! } }, DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT,
        buildDiagnosisMessages(input.application.jd, sanitizeModulesForDiagnosis(modules)), { signal, requireJson: "strict" })
      : await safeChat("summary", { feature: LLM_FEATURES.realInterviewReview }, INTERVIEW_REVIEW_SYSTEM_PROMPT,
        buildInterviewReviewMessages(input.review!.context, input.review!.questions), { signal, requireJson: "strict" });
  signal.throwIfAborted();
  assertDataGeneration();
  const { result } = validatedResult(kind, input, raw);
  if (archive) assertDiagnosisBudget({ ...archive, report: JSON.stringify(result) });
  return inTransaction(() => {
    signal.throwIfAborted();
    recheckSource(kind, applicationId, interviewId, revision);
    const db = getDb();
    const createdAt = now();
    db.prepare("DELETE FROM mcp_drafts WHERE expires_at <= ?").run(createdAt);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const inserted = db.prepare("INSERT INTO mcp_drafts (kind, application_id, interview_id, source_revision, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(kind, applicationId, interviewId ?? null, revision, JSON.stringify(parseModelJson(raw)), createdAt, expiresAt);
    db.exec("DELETE FROM mcp_drafts WHERE id < (SELECT id FROM mcp_drafts ORDER BY id DESC LIMIT 1 OFFSET 99)");
    return boundMcpOutput({ draftId: Number(inserted.lastInsertRowid), applicationId, kind, sourceRevision: revision,
      company: input.application.company, role: input.application.role, result, saved: false, expiresAt,
      fullContent: { tool: "read_record_section", kind: "ai_draft", id: Number(inserted.lastInsertRowid) } });
  });
}

/** Saving requires a separate write tool; it only accepts server-stored, validated draft content. */
export function saveMcpDraft(draftId: number, expectedRevision: string) {
  return inTransaction(() => {
    const db = getDb();
    const draft = db.prepare("SELECT * FROM mcp_drafts WHERE id = ?").get(draftId) as Draft | undefined;
    if (!draft || draft.expires_at <= now()) throw new McpOperationError("NOT_FOUND", "草稿不存在或已过期，请重新生成");
    if (expectedRevision !== draft.source_revision) throw new McpOperationError("CONFLICT", "请提供此草稿的 sourceRevision");
    const tool = `save_ai_draft:${draft.kind}`;
    const target = { jd: "jd_portraits", diagnosis: "resume_diagnoses", review: "application_interview_recaps" }[draft.kind];
    const saved = mcpCreateOnce(tool, `mcp-draft:${draftId}`, { draftId, expectedRevision }, () => {
      const input = recheckSource(draft.kind, draft.application_id, draft.interview_id ?? undefined, expectedRevision, true);
      const { kind, result } = validatedResult(draft.kind, input, draft.payload);
      switch (kind) {
        case "jd": return { id: saveJdPortrait(input.application.jd, result, draft.application_id) };
        case "diagnosis": {
          const row = { ...diagnosisArchive(input), report: JSON.stringify(result) };
          assertDiagnosisBudget(row);
          return { id: saveDiagnosis(row, draft.application_id) };
        }
        case "review": return { id: saveGeneratedInterviewReview(draft.application_id, draft.interview_id!, input.review!, result) };
      }
    }, id => Boolean(db.prepare(`SELECT 1 FROM ${target} WHERE id = ?`).get(id)));
    return { ...saved, draftId, kind: draft.kind, applicationId: draft.application_id, saved: true };
  });
}
