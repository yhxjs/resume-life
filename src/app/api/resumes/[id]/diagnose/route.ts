import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, resolvePreparationApplication } from "@/lib/application-preparation";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { dataGeneration, getDb, inTransaction, now } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { LlmConfigError } from "@/lib/llm";
import { loadResumeForModel } from "@/lib/resumes";
import { ResumeContextError } from "@/lib/resume-errors";
import { validateGeneratedDiagnosis, sanitizeModulesForDiagnosis, type DiagnosisReport, type DiagnosisSnapshot } from "@/lib/diagnosis";
import { assertDiagnosisBudget, canArchiveDiagnosisSnapshot, diagnosisHistory, findMatchingDiagnosisJob, loadDiagnosis, saveDiagnosis } from "@/lib/diagnosis-history";
import { BackupLimitError } from "@/lib/backup-limits";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { recordDiagnosisAdoption } from "@/lib/diagnosis-adoption";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { buildDiagnosisMessages } from "@/lib/diagnosis-llm";
import { DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT } from "@/lib/diagnosis-production-prompt";

async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  const db = getDb();
  if (!db.prepare("SELECT id FROM resumes WHERE id = ?").get(numericId)) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  const query = new URL(req.url).searchParams;
  const diagnosisId = query.get("diagnosis_id");
  const jobId = query.get("job_id");
  const selectedDiagnosisId = diagnosisId === null ? null : parseCanonicalPositiveId(diagnosisId);
  if (diagnosisId !== null && !Number.isSafeInteger(selectedDiagnosisId)) {
    return NextResponse.json({ error: "无效的诊断 ID" }, { status: 400 });
  }
  const latest = diagnosisId === null ? db.prepare(`SELECT id FROM resume_diagnoses WHERE resume_id = ?
    ${jobId === null ? "" : "AND job_id = ?"} ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(...(jobId === null ? [numericId] : [numericId, jobId])) as { id: number } | undefined : undefined;
  const current = diagnosisId !== null ? loadDiagnosis(numericId, selectedDiagnosisId!) : latest ? loadDiagnosis(numericId, latest.id) : null;
  if ((!current && (diagnosisId !== null || jobId !== null)) || (current && jobId !== null && current.job_id !== jobId)) {
    return NextResponse.json({ error: "诊断记录不存在" }, { status: 404 });
  }
  return NextResponse.json({ jd: "", report: null, created_at: "", ...current, ...diagnosisHistory(numericId, current) });
}

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { jd?: unknown; resume_version_id?: unknown; job_id?: unknown; job_title?: unknown; new_job?: unknown; application_id?: unknown } | null;
  const jd = typeof body?.jd === "string" ? body.jd.trim() : "";
  if (!jd) {
    return NextResponse.json({ error: "岗位要求（JD）不能为空" }, { status: 400 });
  }
  let applicationId: number | null;
  let resumeVersionId: number;
  try {
    resumeVersionId = resolveResumeVersionId(numericId, body?.resume_version_id);
    applicationId = resolvePreparationApplication(body, { resumeId: numericId, resumeVersionId, jd });
  }
  catch (error) {
    if (error instanceof PreparationInputError || error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  const data = loadResumeForModel(numericId, resumeVersionId);
  if (!data) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  if ((body?.job_id !== undefined && (typeof body.job_id !== "string" || !body.job_id.trim())) ||
      (body?.job_title !== undefined && (typeof body.job_title !== "string" || body.job_title.trim().length > 100)) ||
      (body?.new_job !== undefined && typeof body.new_job !== "boolean") || (body?.new_job && body.job_id)) {
    return NextResponse.json({ error: "岗位参数无效，岗位名称最多 100 字" }, { status: 400 });
  }
  const db = getDb();
  const generation = dataGeneration(db);
  const existingJob = body?.job_id ? db.prepare("SELECT job_id, job_title FROM resume_diagnoses WHERE resume_id = ? AND job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(numericId, body.job_id as string) as { job_id: string; job_title: string } | undefined : undefined;
  if (body?.job_id && !existingJob) return NextResponse.json({ error: "岗位不存在" }, { status: 404 });
  if (applicationId !== null && existingJob && !db.prepare(`SELECT 1 FROM application_preparation_resources p
    JOIN resume_diagnoses d ON d.id = p.diagnosis_id WHERE p.application_id = ? AND d.job_id = ? AND d.resume_id = ?`).get(applicationId, existingJob.job_id, numericId)) {
    return NextResponse.json({ error: "此诊断岗位未关联当前投递，请返回准备页选择资料" }, { status: 409 });
  }
  const newJobId = randomUUID();
  const requestedTitle = typeof body?.job_title === "string" ? body.job_title.trim() : "";
  const selectJob = () => {
    const job = existingJob ?? (body?.new_job ? undefined : findMatchingDiagnosisJob(numericId, jd, applicationId));
    return { job_id: job?.job_id || newJobId, job_title: requestedTitle || job?.job_title || jd.split("\n")[0]!.slice(0, 60) };
  };
  const snapshot: DiagnosisSnapshot = { title: data.resume.title, modules: data.modules.map(({ key, type, label, sort, content }) => ({ key, type, label, sort, content })) };
  if (!canArchiveDiagnosisSnapshot(snapshot)) {
    return NextResponse.json({ error: "所选版本无法保存完整诊断快照，请核对并修复简历后重新发布，或恢复有效备份后再诊断" }, { status: 422 });
  }
  const stored = { id: Number.MAX_SAFE_INTEGER, resume_id: numericId, resume_version_id: resumeVersionId, ...selectJob(), jd,
    report: "", resume_snapshot: JSON.stringify(snapshot), adoptions: "[]", created_at: now() };
  try { assertDiagnosisBudget(stored); } catch (err) {
    if (!(err instanceof BackupLimitError)) throw err;
    return NextResponse.json({ error: "简历内容过大，无法保存完整诊断快照，请精简后再试" }, { status: 413 });
  }
  const assessmentModules = data.modules.filter((module) => module.type !== "basic");
  if (assessmentModules.length === 0) {
    return NextResponse.json({ error: "所选版本没有可诊断的职业模块，请添加经历、技能或自我评价等职业模块后重新发布，再重试诊断" }, { status: 422 });
  }
  const modelModules = sanitizeModulesForDiagnosis(assessmentModules);

  let raw: string;
  try {
    raw = await safeChat(
      "evaluate",
      { feature: LLM_FEATURES.resumeDiagnose, entity: { type: "resume", id: numericId } },
      `${DIAGNOSIS_PRODUCTION_SYSTEM_PROMPT}\n所有非空文本必须包含可见内容，不用零宽、控制字符或纯标点占位；协议允许的空 gaps 与 suggestions 继续为空。`,
      buildDiagnosisMessages(jd, modelModules),
      {
        signal: req.signal,
        requireJson: "strict"
      }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let report: DiagnosisReport;
  try {
    const parsed = validateGeneratedDiagnosis(JSON.parse(raw), assessmentModules);
    if (!parsed) throw new Error("结构校验未通过");
    report = parsed;
  } catch (err) {
    return NextResponse.json(
      { error: `AI 诊断结果异常：${errorMessage(err)}，请重试` },
      { status: 502 }
    );
  }

  stored.report = JSON.stringify(report);
  return inTransaction(() => {
    if (dataGeneration(db) !== generation) return NextResponse.json({ error: "数据已恢复，请刷新简历后重新诊断" }, { status: 409 });
    // 诊断目标由模块 key 和条目 ID 定位；与职业材料一起复核，且不把对象键顺序当作内容变化。
    const sourceConflict = () => NextResponse.json({ error: "所选简历版本或职业材料已变化或删除，请核对后重新诊断" }, { status: 409 });
    let currentSource;
    try { currentSource = loadResumeForModel(numericId, resumeVersionId); }
    catch (error) {
      if (error instanceof ResumeContextError) return sourceConflict();
      throw error;
    }
    if (!currentSource || !isDeepStrictEqual(
      sanitizeModulesForDiagnosis(currentSource.modules.filter((module) => module.type !== "basic")), modelModules,
    )) {
      return sourceConflict();
    }
    try { if (applicationId !== null) resolvePreparationApplication(body, { resumeId: numericId, resumeVersionId, jd }); }
    catch (error) {
      if (error instanceof PreparationInputError || error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
    // 等模型期间可能已有同一投递的诊断入库；用提交时的分组与时间支持历史比较。
    Object.assign(stored, selectJob(), { created_at: now() });
    try { assertDiagnosisBudget(stored); } catch (err) {
      if (!(err instanceof BackupLimitError)) throw err;
      return NextResponse.json({ error: "诊断报告与快照内容过大，无法完整保存，请精简简历后再试" }, { status: 413 });
    }
    const current = loadDiagnosis(numericId, saveDiagnosis(stored, applicationId))!;
    return NextResponse.json({ ...current, ...diagnosisHistory(numericId, current) });
  });
}

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const numericId = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  const parsed = await parseApiJson<unknown>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as { diagnosis_id?: unknown; module_key?: unknown; suggestion_index?: unknown; value?: unknown } | null;
  if (!Number.isSafeInteger(body?.diagnosis_id) || (body!.diagnosis_id as number) <= 0 || typeof body?.module_key !== "string" ||
      !Number.isSafeInteger(body.suggestion_index) || (body.suggestion_index as number) < 0) {
    return NextResponse.json({ error: "采纳参数无效" }, { status: 400 });
  }
  try {
    const current = recordDiagnosisAdoption(numericId, { diagnosisId: body!.diagnosis_id as number,
      moduleKey: body!.module_key as string, suggestionIndex: body!.suggestion_index as number, value: body!.value });
    return NextResponse.json({ ...current, ...diagnosisHistory(numericId, current) });
  } catch (error) {
    if (error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof BackupLimitError) return NextResponse.json({ error: "采纳记录内容过大，无法完整保存" }, { status: 413 });
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]/diagnose", handleGet);
export const POST = withRouteErrorHandling("POST /api/resumes/[id]/diagnose", handlePost);
export const PATCH = withRouteErrorHandling("PATCH /api/resumes/[id]/diagnose", handlePatch);
