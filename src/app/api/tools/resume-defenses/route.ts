import { withRouteErrorHandling } from "@/lib/api-route";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { loadResume, loadResumeContext } from "@/lib/resumes";
import {
  listDefenseReports,
  normalizeDefenseReport,
  saveDefenseReport,
} from "@/lib/resume-defense";
import {
  RESUME_DEFENSE_SCAN_SYSTEM_PROMPT,
} from "@/lib/resume-defense-llm";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

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
  const body = parsedBody.data as {
      resumeId?: unknown;
      resumeVersionId?: unknown;
      resume_version_id?: unknown;
      resumeContent?: unknown;
      targetRole?: unknown;
      title?: unknown;
    } | null;

    let resumeContent = typeof body?.resumeContent === "string" ? body.resumeContent.trim() : "";
    const targetRole = typeof body?.targetRole === "string" ? body.targetRole.trim() : "";
    let title = typeof body?.title === "string" ? body.title.trim() : "";
    let resumeId: number | null = null;
    let resumeVersionId: number | null = null;
    if (body?.resumeId == null && (body?.resume_version_id != null || body?.resumeVersionId != null)) {
      return NextResponse.json({ error: "请选择版本所属的简历" }, { status: 400 });
    }

    if (body?.resumeId !== undefined && body?.resumeId !== null) {
      const numId = Number(body.resumeId);
      if (!Number.isSafeInteger(numId) || numId <= 0) return NextResponse.json({ error: "请选择有效的简历" }, { status: 400 });
      resumeId = numId;
      resumeVersionId = resolveResumeVersionId(numId, body.resume_version_id ?? body.resumeVersionId);
      const loaded = loadResume(numId, resumeVersionId);
      if (!loaded) return NextResponse.json({ error: "简历不存在" }, { status: 404 });
      if (!title) title = `${loaded.resume.title} - 简历排雷`;
      resumeContent = loadResumeContext(numId, resumeVersionId);
    }

    if (!resumeContent) {
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
        [
          {
            role: "user",
            parts: [
              ...(targetRole
                ? [
                    { trust: "trusted", text: "【目标岗位】\n" } as const,
                    { trust: "untrusted", tag: "target_role", text: targetRole } as const,
                    { trust: "trusted", text: "\n\n" } as const,
                  ]
                : []),
              { trust: "trusted", text: "【候选人简历】\n" },
              { trust: "untrusted", tag: "candidate_resume", text: resumeContent },
              { trust: "trusted", text: "\n\n请逐行扫描，圈出高危疑点、给出毒舌吐槽、致命追问与防御预案。" },
            ],
          },
        ],
        { signal: req.signal, requireJson: true }
      );
    } catch (err) {
      const msg =
        err instanceof LlmConfigError
          ? err.message
          : errorMessage(err);
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    let parsedReport: ReturnType<typeof normalizeDefenseReport>;
    try {
      const json = extractJson<unknown>(raw);
      parsedReport = normalizeDefenseReport(json);
    } catch (err) {
      return NextResponse.json(
        {
          error: `毒舌面试官解析异常（${errorMessage(err)}），请稍后重试`,
          raw,
        },
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
    });

    return NextResponse.json(saved);
  } catch (err) {
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
