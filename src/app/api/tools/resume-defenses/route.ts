import { withRouteErrorHandling } from "@/lib/api-route";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { LlmConfigError } from "@/lib/llm";
import { loadResumeForModel, formatResumeContext, formatResumeEvidenceText, collectResumeEvidenceParts } from "@/lib/resumes";
import { ResumeContextError } from "@/lib/resume-errors";
import {
  listDefenseReports,
  validateGeneratedDefenseReport,
  saveDefenseReport,
} from "@/lib/resume-defense";
import {
  buildResumeDefenseScanMessages,
  RESUME_DEFENSE_SCAN_SYSTEM_PROMPT,
} from "@/lib/resume-defense-llm";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";

async function handleGet(request?: Request) {
  try {
    const list = listDefenseReports();
    return NextResponse.json({ items: list });
  } catch (err) {
    const requestId = logServerError("resume-defenses.list", err, { requestId: requestIdFrom(request), status: 500 });
    return NextResponse.json(
      { error: "读取排雷报告失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

async function handlePost(req: Request) {
  try {
    const parsedBody = await parseApiJson<unknown>(req);
    if (!parsedBody.ok) return parsedBody.response;
    if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
      return NextResponse.json({ error: "排雷请求必须是 JSON 对象" }, { status: 400 });
    }
    const body = parsedBody.data as {
      resumeId?: unknown;
      resumeVersionId?: unknown;
      resume_version_id?: unknown;
      resumeContent?: unknown;
      targetRole?: unknown;
      title?: unknown;
    };
    for (const field of ["resumeContent", "targetRole", "title"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        return NextResponse.json({ error: "简历原文、目标岗位和报告标题必须是字符串" }, { status: 400 });
      }
    }

    let resumeContent = typeof body?.resumeContent === "string" ? body.resumeContent.trim() : "";
    let modelResumeContent = resumeContent;
    let resumeEvidenceParts: string[] | undefined;
    const targetRole = typeof body?.targetRole === "string" ? body.targetRole.trim() : "";
    let title = typeof body?.title === "string" ? body.title.trim() : "";
    let resumeId: number | null = null;
    let resumeVersionId: number | null = null;
    if (body?.resumeId == null && (body?.resume_version_id != null || body?.resumeVersionId != null)) {
      return NextResponse.json({ error: "请选择版本所属的简历" }, { status: 400 });
    }

    if (body?.resumeId !== undefined && body?.resumeId !== null) {
      if (typeof body.resumeId !== "number" || !Number.isSafeInteger(body.resumeId) || body.resumeId <= 0) {
        return NextResponse.json({ error: "请选择有效的简历" }, { status: 400 });
      }
      resumeId = body.resumeId;
      resumeVersionId = resolveResumeVersionId(resumeId, body.resume_version_id ?? body.resumeVersionId);
      const loaded = loadResumeForModel(resumeId, resumeVersionId);
      if (!loaded) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
      if (!title) title = `${loaded.resume.title} - 简历排雷`;
      modelResumeContent = formatResumeContext(loaded.modules);
      resumeContent = formatResumeEvidenceText(loaded.modules);
      resumeEvidenceParts = collectResumeEvidenceParts(loaded.modules);
    }

    if (!modelResumeContent) {
      return NextResponse.json(
        { error: "请提供要排雷的简历内容，或选择一份已有简历" },
        { status: 400 }
      );
    }

    let raw: string;
    try {
      raw = await safeChat(
        "question",
        {
          feature: LLM_FEATURES.defenseScan,
          ...(resumeId !== null ? { entity: { type: "resume", id: resumeId } } : {}),
        },
        RESUME_DEFENSE_SCAN_SYSTEM_PROMPT,
        buildResumeDefenseScanMessages(targetRole, modelResumeContent),
        {
          signal: req.signal,
          requireJson: "strict"
        }
      );
    } catch (err) {
      const msg =
        err instanceof LlmConfigError
          ? err.message
          : errorMessage(err);
      return NextResponse.json({ error: msg }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
    }

    let parsedReport: ReturnType<typeof validateGeneratedDefenseReport> = null;
    try {
      const json: unknown = JSON.parse(raw);
      parsedReport = validateGeneratedDefenseReport(json, resumeContent, resumeEvidenceParts);
    } catch {
      // 无效 JSON 或不完整结果统一拒绝，不用默认负面点评替代模型输出。
    }
    if (!parsedReport) {
      return NextResponse.json(
        { error: "AI 排雷结果异常：结构不完整或引用缺少原文依据，请重试" },
        { status: 502 }
      );
    }

    const saved = saveDefenseReport({
      resumeId,
      resumeVersionId,
      title: title || (targetRole ? `${targetRole} - 简历排雷` : "简历排雷报告"),
      sourceContent: resumeContent,
      targetRole,
      riskLevel: parsedReport.riskLevel,
      overallRoast: parsedReport.overallRoast,
      items: parsedReport.items,
    }, resumeId === null ? undefined : { resumeContext: modelResumeContent });

    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof ResumeContextError) throw err;
    if (err instanceof ResumeVersionError) return NextResponse.json({ error: err.message }, { status: err.status });
    const requestId = logServerError("resume-defenses.create", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json(
      { error: "保存排雷报告失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/tools/resume-defenses", handleGet);
export const POST = withRouteErrorHandling("POST /api/tools/resume-defenses", handlePost);
