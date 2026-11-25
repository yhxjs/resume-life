import { createHash, randomUUID } from "node:crypto";
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
import { McpOperationError, classifyMcpError } from "./mcp-errors";
import { canonicalMcpJson, mcpRevision } from "./mcp-revision";
import { mcpDraftResultSchema } from "./mcp-draft-format";
import { mcpCreateOnce } from "./mcp-state";
import { boundMcpOutput } from "./mcp-output";
import { assertOperationActive, OperationTimeoutError } from "./operation-deadline";
import { assertDataGeneration } from "./data-generation";
import { beginMcpGeneration, clearUnavailableMcpGenerationPayloads, completeMcpGeneration, failMcpGeneration, findMcpGenerationRequest, replayMcpGeneration, setMcpGenerationPhase, type McpGenerationRequest } from "./mcp-generation";

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

/** 同一来源令牌与提示格式供外部模型使用；本工具自身不调用模型。 */
export function getMcpAiWorkflowContext(kind: Kind, applicationId: number, interviewId?: number, complete = false) {
  const input = source(kind, applicationId, interviewId);
  const modules = input.resume?.modules.filter(module => module.type !== "basic") ?? [];
  if (kind === "diagnosis") {
    if (!modules.length) throw new McpOperationError("INVALID_ARGUMENT", "所选简历版本没有可诊断的职业模块");
    assertDiagnosisBudget(diagnosisArchive(input));
  }
  const context = { application: input.application,
    ...(input.resume ? { resume: diagnosisSnapshot(input.resume), diagnosisModules: sanitizeModulesForDiagnosis(modules) } : {}),
    ...(input.review ? { review: input.review } : {}) };
  const value = { kind, applicationId, interviewId: interviewId ?? null, sourceRevision: sourceRevision(kind, input), context,
    resultSchema: mcpDraftResultSchema(kind, modules.map(module => module.key), input.review?.questions.length),
    outputInstructions: kind === "jd" ? JD_PORTRAIT_SYSTEM_PROMPT : kind === "diagnosis" ? DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT : INTERVIEW_REVIEW_SYSTEM_PROMPT,
    fullContent: { tool: "read_record_section", kind: "ai_workflow_context", id: applicationId, workflowKind: kind, ...(interviewId === undefined ? {} : { interviewId }) } };
  return complete ? value : boundMcpOutput(value);
}

function storeDraft(kind: Kind, applicationId: number, interviewId: number | undefined, revision: string,
  raw: string, input: Source, result: object, request: McpGenerationRequest) {
  const db = getDb();
  const createdAt = now();
  db.prepare("DELETE FROM mcp_drafts WHERE expires_at <= ?").run(createdAt);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const inserted = db.prepare("INSERT INTO mcp_drafts (kind, application_id, interview_id, source_revision, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(kind, applicationId, interviewId ?? null, revision, raw, createdAt, expiresAt);
  db.exec("DELETE FROM mcp_drafts WHERE id < (SELECT id FROM mcp_drafts ORDER BY id DESC LIMIT 1 OFFSET 99)");
  const response = boundMcpOutput({ draftId: Number(inserted.lastInsertRowid), applicationId, kind, sourceRevision: revision, idempotencyKey: request.request_key,
    company: input.application.company, role: input.application.role, result, saved: false, savedRecord: null, expiresAt,
    fullContent: { tool: "read_record_section", kind: "ai_draft", id: Number(inserted.lastInsertRowid) } });
  completeMcpGeneration(request, response);
  clearUnavailableMcpGenerationPayloads();
  return response;
}

export function submitMcpDraft(input: { kind: Kind; applicationId: number; interviewId?: number; expectedSourceRevision: string; idempotencyKey: string; result: unknown }) {
  if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) throw new McpOperationError("INVALID_ARGUMENT", "提交草稿必须是 JSON 对象");
  const raw = JSON.stringify(input.result);
  const canonical = canonicalMcpJson(input.result);
  return inTransaction(() => {
    const signature = { kind: input.kind, applicationId: input.applicationId, interviewId: input.interviewId,
      submission: { sourceRevision: input.expectedSourceRevision, payloadHash: createHash("sha256").update(canonical).digest("hex") } };
    const previous = findMcpGenerationRequest(input.idempotencyKey, signature);
    if (previous) return replayMcpGeneration(previous);
    const context = recheckSource(input.kind, input.applicationId, input.interviewId, input.expectedSourceRevision);
    let result: object;
    try { result = validatedResult(input.kind, context, raw).result; }
    catch (error) {
      if (error instanceof McpOperationError && error.code === "MODEL_OUTPUT") throw new McpOperationError("INVALID_ARGUMENT", "提交草稿不符合结果格式，请按 get_ai_workflow_context 返回的格式修正");
      throw error;
    }
    if (input.kind === "diagnosis") assertDiagnosisBudget({ ...diagnosisArchive(context), report: JSON.stringify(result) });
    const request = beginMcpGeneration(input.idempotencyKey, signature, input.expectedSourceRevision);
    return storeDraft(input.kind, input.applicationId, input.interviewId, input.expectedSourceRevision, raw, context, result, request);
  });
}

export async function generateMcpDraft(kind: Kind, applicationId: number, signal: AbortSignal, interviewId?: number, idempotencyKey: string = randomUUID()) {
  signal.throwIfAborted();
  const started = inTransaction(() => {
    const signature = { kind, applicationId, interviewId };
    const previous = findMcpGenerationRequest(idempotencyKey, signature);
    if (previous) return { replay: true as const, response: replayMcpGeneration(previous) };
    const input = source(kind, applicationId, interviewId);
    const revision = sourceRevision(kind, input);
    const modules = input.resume?.modules.filter(module => module.type !== "basic") ?? [];
    if (kind === "diagnosis" && !modules.length) throw new McpOperationError("INVALID_ARGUMENT", "所选简历版本没有可诊断的职业模块");
    const archive = kind === "diagnosis" ? diagnosisArchive(input) : null;
    if (archive) assertDiagnosisBudget(archive);
    return { replay: false as const, input, revision, modules, archive, request: beginMcpGeneration(idempotencyKey, signature, revision) };
  });
  if (started.replay) return started.response;
  const { input, revision, modules, archive, request } = started;
  try {
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
    setMcpGenerationPhase(request, "validating");
    const { result } = validatedResult(kind, input, raw);
    if (archive) assertDiagnosisBudget({ ...archive, report: JSON.stringify(result) });
    return inTransaction(() => {
      signal.throwIfAborted();
      recheckSource(kind, applicationId, interviewId, revision);
      return storeDraft(kind, applicationId, interviewId, revision, JSON.stringify(parseModelJson(raw)), input, result, request);
    });
  } catch (error) {
    const failure = signal.aborted ? (signal.reason instanceof OperationTimeoutError ? "TIMEOUT" : "CANCELLED") : classifyMcpError(error).code;
    failMcpGeneration(request, failure);
    if (failure === "BUSY" || failure === "TIMEOUT") {
      // The claimed key is never released, even when recording its failure cannot obtain a lock.
      throw new McpOperationError(failure,
        `${failure === "BUSY" ? "生成请求因服务或数据库繁忙未完成" : "生成请求超时未完成"}，请使用 get_ai_generation_request 查询请求状态；同一键不会重新调用模型，确认需要重新生成后请使用新键`,
        { retryable: false, cause: error });
    }
    throw error;
  }
}

/** Saving requires a separate write tool and always revalidates stored draft content and source. */
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
