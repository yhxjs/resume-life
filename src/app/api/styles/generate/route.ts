import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { LlmConfigError } from "@/lib/llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { DEFAULT_STYLE, isCompleteGeneratedStyle, normalizeStyle, type ResumeStyle } from "@/lib/templates";
import { errorMessage } from "@/lib/error-message";
import { buildStyleGenerationMessages, STYLE_GENERATION_SYSTEM_PROMPT } from "@/lib/style-generation-llm";

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return NextResponse.json({ error: "请先描述你想要的模板风格" }, { status: 400 });
  if (prompt.length > 500) {
    return NextResponse.json({ error: "风格描述不能超过 500 字" }, { status: 400 });
  }

  let raw: string;
  try {
    raw = await safeChat(
      "question",
      { feature: LLM_FEATURES.styleGenerate },
      STYLE_GENERATION_SYSTEM_PROMPT,
      buildStyleGenerationMessages(prompt),
      {
        signal: req.signal,
        requireJson: "strict"
      }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  let style: ResumeStyle;
  try {
    const candidate: unknown = JSON.parse(raw);
    if (!isCompleteGeneratedStyle(candidate)) {
      throw new Error("结构校验未通过：必须返回完整且合法的样式参数");
    }
    const parsed = normalizeStyle(candidate);
    if (!parsed) throw new Error("结构校验未通过");
    const unchanged = (Object.keys(DEFAULT_STYLE) as (keyof ResumeStyle)[])
      .every((key) => parsed[key] === DEFAULT_STYLE[key]);
    if (unchanged) throw new Error("没有生成有效的个性化样式");
    style = parsed;
  } catch (err) {
    return NextResponse.json(
      { error: `AI 生成的样式参数异常：${errorMessage(err)}，请重试` },
      { status: 502 }
    );
  }
  return NextResponse.json({ style });
}

export const POST = withRouteErrorHandling("POST /api/styles/generate", handlePost);
