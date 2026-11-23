import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { LlmConfigError } from "@/lib/llm";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { loadResume } from "@/lib/resumes";
import {
  buildPolishMessages,
  validateGeneratedPolishResult,
  type PolishContext,
  type PolishMode,
} from "@/lib/polish";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = parseCanonicalPositiveId(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  }

  const resumeData = loadResume(numericId);
  if (!resumeData) {
    return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
    return NextResponse.json({ error: "润色请求必须是 JSON 对象" }, { status: 400 });
  }
  const body = parsedBody.data as {
    text?: unknown;
    sourceParagraphs?: unknown;
    originalSourceParagraphs?: unknown;
    moduleType?: unknown;
    mode?: unknown;
    context?: unknown;
    targetRole?: unknown;
  };

  if ((body.text !== undefined && typeof body.text !== "string") ||
    (body.targetRole !== undefined && typeof body.targetRole !== "string")) {
    return NextResponse.json({ error: "润色原文和目标岗位必须是字符串" }, { status: 400 });
  }
  if (body.sourceParagraphs !== undefined && (!Array.isArray(body.sourceParagraphs) ||
    body.sourceParagraphs.some(paragraph => typeof paragraph !== "string"))) {
    return NextResponse.json({ error: "来源段落必须是字符串数组" }, { status: 400 });
  }
  if (body.originalSourceParagraphs !== undefined && (!Array.isArray(body.originalSourceParagraphs) ||
    body.originalSourceParagraphs.some(paragraph => typeof paragraph !== "string"))) {
    return NextResponse.json({ error: "二次精简的原始资料必须是字符串数组" }, { status: 400 });
  }
  if (body.moduleType !== undefined && body.moduleType !== "work" && body.moduleType !== "projects" && body.moduleType !== "summary") {
    return NextResponse.json({ error: "无效的润色模块类型" }, { status: 400 });
  }
  if (body.mode !== undefined && body.mode !== "star" && body.mode !== "quantify" && body.mode !== "summary" && body.mode !== "condense") {
    return NextResponse.json({ error: "无效的润色模式" }, { status: 400 });
  }
  const context: PolishContext = {};
  if (body.context !== undefined) {
    if (!body.context || typeof body.context !== "object" || Array.isArray(body.context)) {
      return NextResponse.json({ error: "润色上下文必须是 JSON 对象" }, { status: 400 });
    }
    const fields = body.context as Record<string, unknown>;
    for (const field of ["company", "title", "name", "role"] as const) {
      const value = fields[field];
      if (value !== undefined && typeof value !== "string") {
        return NextResponse.json({ error: "润色上下文的公司、职位、项目及角色必须是字符串" }, { status: 400 });
      }
      if (typeof value === "string") context[field] = value;
    }
  }

  const text = typeof body?.text === "string" ? body.text : "";
  const rawParagraphs = Array.isArray(body?.sourceParagraphs)
    ? body.sourceParagraphs
        .map((p: string) => p.trim())
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
  const targetRole = typeof body?.targetRole === "string" ? body.targetRole : "";
  const originalSourceParagraphs = Array.isArray(body.originalSourceParagraphs)
    ? body.originalSourceParagraphs.map((paragraph: string) => paragraph.trim()).filter(Boolean) : undefined;
  if (originalSourceParagraphs !== undefined && mode !== "condense") {
    return NextResponse.json({ error: "原始资料对照仅用于二次精简" }, { status: 400 });
  }

  const { system, messages } = buildPolishMessages({
    text,
    sourceParagraphs: rawParagraphs,
    originalSourceParagraphs,
    moduleType,
    mode,
    context,
    targetRole,
  });

  let raw: string;
  try {
    raw = await safeChat(
      "summary",
      { feature: LLM_FEATURES.resumePolish, entity: { type: "resume", id: numericId } },
      system,
      messages,
      {
        signal: req.signal,
        requireJson: "strict"
      }
    );
  } catch (err) {
    const message =
      err instanceof LlmConfigError
        ? err.message
        : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  try {
    const parsed = validateGeneratedPolishResult(JSON.parse(raw), context, {
      sourceCount: rawParagraphs.length || (text.trim() ? 1 : 0),
      originalSourceCount: originalSourceParagraphs?.length,
      moduleType,
      mode,
    });
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
