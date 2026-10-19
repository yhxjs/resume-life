import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, resolvePreparationApplication, linkPreparationResource } from "@/lib/application-preparation";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { dataGeneration, getDb, inTransaction, now } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { loadResume } from "@/lib/resumes";
import { diagnosisValue, normalizeDiagnosis, sanitizeModulesForDiagnosis, type DiagnosisReport, type DiagnosisSnapshot } from "@/lib/diagnosis";
import { assertDiagnosisBudget, diagnosisHistory, loadDiagnosis } from "@/lib/diagnosis-history";
import { BackupLimitError } from "@/lib/backup-limits";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { splitRichTextToLines } from "@/lib/rich-text";

const SYSTEM_PROMPT = `你是资深技术招聘专家。请对照【岗位要求（JD）】对候选人简历做逐模块体检，输出 JSON：
{
  "match": 0 到 10 的总体岗位匹配度（一位小数）,
  "summary": "总评：两三句话概括简历与该岗位的整体贴合情况与最优先要改的点",
  "modules": [
    {
      "module_key": "照抄输入中该简历模块的 key",
      "scores": { "depth": 1-10, "structure": 1-10, "authenticity": 1-10, "completeness": 1-10 },
      "gaps": "该模块与岗位要求的差距：缺失的能力/关键词、表述与 JD 不匹配或不具体的地方",
      "suggestions": [
        { "item_id": "条目 id（field=description 时必填，其余为空字符串）", "field": "description", "reason": "为什么要这样改（对应 JD 哪条要求）", "draft": "改写后的完整替换文本" }
      ]
    }
  ]
}
评分维度（各 1-10 的整数）：
- depth 技术深度：内容是否体现原理与取舍
- structure 结构表达：STAR 完整性与条理
- authenticity 真实性：表述可信、无夸大编造痕迹
- completeness 完整度：该模块信息覆盖是否充分
改写建议规则：
- 只允许三种目标：教育/工作/项目条目的 description（field="description"，须带该条目的 item_id）、自我评价的 text（field="text"）、技能的 items（field="items"，draft 为字符串数组，覆盖全部技能）
- 只基于候选人已有内容优化表达：对齐 JD 关键词、突出相关成果、量化结果、补齐 STAR 结构；严禁编造不存在的经历、技能或数据
- draft 是确认后整段替换原文的最终纯文本，不是修改说明，严禁包含 HTML 标签或排版代码
- 评估请聚焦经历本身、业务成果与技术深度，不要将排版格式作为缺陷
- 经历时间线以当前日期为基准，不得将当前日期及之前的经历误判为未来时间
- 没有值得改的内容就给空数组
要求：提供的每个职业内容模块都必须出现在 modules 里（哪怕没有建议）；基本身份与联系方式不参与评估；只输出 JSON。`;

async function handleGet(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }
  const db = getDb();
  if (!db.prepare("SELECT id FROM resumes WHERE id = ?").get(numericId)) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  const query = new URL(req.url).searchParams;
  const diagnosisId = query.get("diagnosis_id");
  const jobId = query.get("job_id");
  if (diagnosisId !== null && (!Number.isSafeInteger(Number(diagnosisId)) || Number(diagnosisId) <= 0)) {
    return NextResponse.json({ error: "无效的诊断 ID" }, { status: 400 });
  }
  const latest = diagnosisId === null ? db.prepare(`SELECT id FROM resume_diagnoses WHERE resume_id = ?
    ${jobId === null ? "" : "AND job_id = ?"} ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(...(jobId === null ? [numericId] : [numericId, jobId])) as { id: number } | undefined : undefined;
  const current = diagnosisId !== null ? loadDiagnosis(numericId, Number(diagnosisId)) : latest ? loadDiagnosis(numericId, latest.id) : null;
  if ((!current && (diagnosisId !== null || jobId !== null)) || (current && jobId !== null && current.job_id !== jobId)) {
    return NextResponse.json({ error: "诊断记录不存在" }, { status: 404 });
  }
  return NextResponse.json({ jd: "", report: null, created_at: "", ...current, ...diagnosisHistory(numericId, current) });
}

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
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

  const data = loadResume(numericId, resumeVersionId);
  if (!data) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  if (data.corruptedKeys.length) return NextResponse.json({ error: "简历包含损坏模块，请先修复后再诊断" }, { status: 409 });
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
  const matchingJob = !existingJob && !body?.new_job ? db.prepare(`SELECT job_id, job_title FROM resume_diagnoses d WHERE resume_id = ? AND
    ${applicationId === null ? "jd = ?" : "EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id = ? AND p.diagnosis_id = d.id)"}
    ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(numericId, applicationId ?? jd) as { job_id: string; job_title: string } | undefined : undefined;
  const jobId = existingJob?.job_id || matchingJob?.job_id || randomUUID();
  const jobTitle = (typeof body?.job_title === "string" ? body.job_title.trim() : "") || existingJob?.job_title || matchingJob?.job_title || jd.split("\n")[0]!.slice(0, 60);
  const ts = now();
  const snapshot: DiagnosisSnapshot = { title: data.resume.title, modules: data.modules.map(({ key, type, label, sort, content }) => ({ key, type, label, sort, content })) };
  const stored = { id: Number.MAX_SAFE_INTEGER, resume_id: numericId, resume_version_id: resumeVersionId, job_id: jobId, job_title: jobTitle, jd,
    report: "", resume_snapshot: JSON.stringify(snapshot), adoptions: "[]", created_at: ts };
  try { assertDiagnosisBudget(stored); } catch (err) {
    if (!(err instanceof BackupLimitError)) throw err;
    return NextResponse.json({ error: "简历内容过大，无法保存完整诊断快照，请精简后再试" }, { status: 413 });
  }
  const assessmentModules = data.modules.filter((module) => module.type !== "basic");

  let raw: string;
  try {
    raw = await safeChat(
      "evaluate",
      { feature: LLM_FEATURES.resumeDiagnose, entity: { type: "resume", id: numericId } },
      SYSTEM_PROMPT,
      [
        {
          role: "user",
          parts: [
            { trust: "untrusted", tag: "job_description", text: jd },
            { trust: "trusted", text: "\n\n" },
            {
              trust: "untrusted",
              tag: "candidate_resume_modules",
              text: JSON.stringify(sanitizeModulesForDiagnosis(assessmentModules)),
            },
            { trust: "trusted", text: "\n\n请输出诊断 JSON。" },
          ],
        },
      ],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  let report: DiagnosisReport;
  try {
    const parsed = normalizeDiagnosis(extractJson<unknown>(raw), assessmentModules);
    if (!parsed) throw new Error("结构校验未通过");
    report = parsed;
  } catch (err) {
    return NextResponse.json(
      { error: `AI 诊断结果异常：${errorMessage(err)}，请重试` },
      { status: 502 }
    );
  }

  stored.report = JSON.stringify(report);
  try { assertDiagnosisBudget(stored); } catch (err) {
    if (!(err instanceof BackupLimitError)) throw err;
    return NextResponse.json({ error: "诊断报告与快照内容过大，无法完整保存，请精简简历后再试" }, { status: 413 });
  }
  return inTransaction(() => {
    if (dataGeneration(db) !== generation) return NextResponse.json({ error: "数据已恢复，请刷新简历后重新诊断" }, { status: 409 });
    try { if (applicationId !== null) resolvePreparationApplication(body, { resumeId: numericId, resumeVersionId, jd }); }
    catch (error) {
      if (error instanceof PreparationInputError || error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
    if (!db.prepare("SELECT id FROM resumes WHERE id = ?").get(numericId)) return NextResponse.json({ error: "简历已删除" }, { status: 409 });
    const saved = db.prepare(`INSERT INTO resume_diagnoses (resume_id, resume_version_id, job_id, job_title, jd, report, resume_snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(numericId, resumeVersionId, jobId, jobTitle, jd, stored.report, stored.resume_snapshot, ts);
    const current = loadDiagnosis(numericId, Number(saved.lastInsertRowid))!;
    if (applicationId !== null) linkPreparationResource(applicationId, "diagnosis", current.id);
    return NextResponse.json({ ...current, ...diagnosisHistory(numericId, current) });
  });
}

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const numericId = Number((await params).id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  const parsed = await parseApiJson<unknown>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as { diagnosis_id?: unknown; module_key?: unknown; suggestion_index?: unknown; value?: unknown } | null;
  if (!Number.isSafeInteger(body?.diagnosis_id) || (body!.diagnosis_id as number) <= 0 || typeof body?.module_key !== "string" ||
      !Number.isSafeInteger(body.suggestion_index) || (body.suggestion_index as number) < 0) {
    return NextResponse.json({ error: "采纳参数无效" }, { status: 400 });
  }
  const moduleKey = body.module_key;
  const suggestionIndex = body.suggestion_index as number;
  return inTransaction(() => {
    const current = loadDiagnosis(numericId, body.diagnosis_id as number);
    if (!current) return NextResponse.json({ error: "诊断记录不存在" }, { status: 404 });
    const suggestion = current.report?.modules.find((module) => module.moduleKey === moduleKey)?.suggestions[suggestionIndex];
    const value = body.value;
    if (!suggestion || (suggestion.field === "items"
      ? !Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.trim())
      : typeof value !== "string" || !value.trim())) {
      return NextResponse.json({ error: "建议或采纳内容无效" }, { status: 400 });
    }
    const data = loadResume(numericId);
    const mod = data?.modules.find((entry) => entry.key === moduleKey);
    // 经历编辑器会移除列表前缀，采纳记录与真正落库的文本保持一致。
    const savedValue = suggestion.field === "description" && (mod?.type === "work" || mod?.type === "projects")
      ? splitRichTextToLines(value as string).join("\n") : value;
    if (!data || JSON.stringify(diagnosisValue(data.modules, moduleKey, suggestion)) !== JSON.stringify(savedValue)) {
      return NextResponse.json({ error: "采纳内容尚未保存或已被修改，请确认简历保存成功后重试" }, { status: 409 });
    }
    if (!current.adoptions.some((entry) => entry.moduleKey === moduleKey && entry.suggestionIndex === suggestionIndex)) {
      current.adoptions.push({ moduleKey, suggestionIndex, value: savedValue as string | string[], applied_at: now() });
      const adoptions = JSON.stringify(current.adoptions);
      const stored = getDb().prepare("SELECT * FROM resume_diagnoses WHERE resume_id = ? AND id = ?").get(numericId, current.id)!;
      try { assertDiagnosisBudget({ ...stored, adoptions }); } catch (err) {
        if (!(err instanceof BackupLimitError)) throw err;
        return NextResponse.json({ error: "采纳记录内容过大，无法完整保存" }, { status: 413 });
      }
      getDb().prepare("UPDATE resume_diagnoses SET adoptions = ? WHERE resume_id = ? AND id = ?").run(adoptions, numericId, current.id);
    }
    return NextResponse.json({ ...current, ...diagnosisHistory(numericId, current) });
  });
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]/diagnose", handleGet);
export const POST = withRouteErrorHandling("POST /api/resumes/[id]/diagnose", handlePost);
export const PATCH = withRouteErrorHandling("PATCH /api/resumes/[id]/diagnose", handlePatch);
