import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { loadResume } from "@/lib/resumes";
import {
  buildPolishPrompt,
  normalizePolishResult,
  type PolishContext,
  type PolishMode,
} from "@/lib/polish";
import { safeChat, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

type PromptMarker = { token: string; tag: string; text: string };

function splitPromptMarkers(template: string, markers: PromptMarker[]): PromptPart[] {
  const occurrences = markers
    .map((marker) => ({ ...marker, index: template.indexOf(marker.token) }))
    .filter((marker) => marker.index >= 0)
    .sort((a, b) => a.index - b.index);
  const parts: PromptPart[] = [];
  let offset = 0;
  for (const marker of occurrences) {
    if (marker.index > offset) {
      parts.push({ trust: "trusted", text: template.slice(offset, marker.index) });
    }
    parts.push({ trust: "untrusted", tag: marker.tag, text: marker.text });
    offset = marker.index + marker.token.length;
  }
  if (offset < template.length) {
    parts.push({ trust: "trusted", text: template.slice(offset) });
  }
  return parts;
}

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }

  const resumeData = loadResume(numericId);
  if (!resumeData) {
    return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    text?: unknown;
    sourceParagraphs?: unknown;
    moduleType?: unknown;
    mode?: unknown;
    context?: unknown;
    targetRole?: unknown;
  } | null;

  const text = typeof body?.text === "string" ? body.text : "";
  const rawParagraphs = Array.isArray(body?.sourceParagraphs)
    ? body.sourceParagraphs
        .map((p) => (typeof p === "string" ? p.trim() : ""))
        .filter(Boolean)
    : [];
  const moduleType =
    body?.moduleType === "work" || body?.moduleType === "projects" || body?.moduleType === "summary"
      ? body.moduleType
      : "projects";
  const mode: PolishMode =
    body?.mode === "star" ||
    body?.mode === "quantify" ||
    body?.mode === "summary" ||
    body?.mode === "condense"
      ? body.mode
      : moduleType === "summary"
        ? "summary"
        : "star";
  const context = (body?.context && typeof body.context === "object" ? body.context : {}) as PolishContext;
  const targetRole = typeof body?.targetRole === "string" ? body.targetRole : "";

  const markers: PromptMarker[] = [];
  const markedContext: PolishContext = {};
  const mark = (token: string, tag: string, value: unknown) => {
    markers.push({ token, tag, text: String(value) });
    return token;
  };
  if (context.company) {
    markedContext.company = mark("__SAFE_POLISH_COMPANY__", "company_name", context.company);
  }
  if (context.title) {
    markedContext.title = mark("__SAFE_POLISH_TITLE__", "job_title", context.title);
  }
  if (context.name) {
    markedContext.name = mark("__SAFE_POLISH_PROJECT__", "project_name", context.name);
  }
  if (context.role) {
    markedContext.role = mark("__SAFE_POLISH_ROLE__", "project_role", context.role);
  }
  const markedTargetRole = targetRole.trim()
    ? mark("__SAFE_POLISH_TARGET__", "target_role", targetRole.trim())
    : "";
  const markedText = text.trim()
    ? mark("__SAFE_POLISH_SOURCE__", "resume_source", text.trim())
    : "";
  const markedSourceParagraphs = rawParagraphs.length > 1
    ? rawParagraphs.map((p, idx) =>
        mark(`__SAFE_POLISH_SOURCE_P_${idx + 1}__`, `resume_source_paragraph_${idx + 1}`, p)
      )
    : undefined;

  const { system, user } = buildPolishPrompt({
    text: markedText,
    sourceParagraphs: markedSourceParagraphs,
    moduleType,
    mode,
    context: markedContext,
    targetRole: markedTargetRole,
  });

  let raw: string;
  try {
    raw = await safeChat(
      "summary",
      { feature: LLM_FEATURES.resumePolish, entity: { type: "resume", id: numericId } },
      system,
      [
        { role: "user", parts: splitPromptMarkers(user, markers) },
      ],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message =
      err instanceof LlmConfigError
        ? err.message
        : errorMessage(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
    const parsed = normalizePolishResult(extractJson<unknown>(raw), context);
    if (!parsed) {
      throw new Error("AI 润色返回格式未通过校验");
    }
    return NextResponse.json({ result: parsed });
  } catch (err) {
    return NextResponse.json(
      {
        error: `AI 润色结果解析失败：${
          errorMessage(err)
        }，请重试`,
      },
      { status: 502 }
    );
  }
}

export const POST = withRouteErrorHandling("POST /api/resumes/[id]/polish", handlePost);
