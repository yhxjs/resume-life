import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { introVersionRevision, saveIntroVersion } from "@/lib/intro-versions";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { isIntroKind, normalizeSentences } from "@/lib/intro";
import { INTRO_SYSTEM_PROMPT, buildGenerateUserMessage } from "@/lib/intro-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

/** 重新生成一版（30s 或 2min）：整版替换句子与点评，需前端确认后调用 */
async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const introId = Number(id);
  if (!Number.isInteger(introId)) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { kind?: unknown; baseRevision?: unknown } | null;
  const kind = body?.kind;
  if (!isIntroKind(kind)) {
    return NextResponse.json({ error: "无效的版本" }, { status: 400 });
  }

  const db = getDb();
  const intro = db.prepare("SELECT resume_id, resume_version_id, jd FROM intros WHERE id = ?").get(introId) as
    | { resume_id: number; resume_version_id: number | null; jd: string }
    | undefined;
  if (!intro) return NextResponse.json({ error: "记录不存在" }, { status: 404 });

  const version = db
    .prepare("SELECT id, sentences, updated_at FROM intro_versions WHERE intro_id = ? AND kind = ?")
    .get(introId, kind) as { id: number; sentences: string; updated_at: string } | undefined;
  if (!version) return NextResponse.json({ error: "版本不存在" }, { status: 404 });
  const revision = introVersionRevision(version);
  if (body?.baseRevision !== undefined && body.baseRevision !== revision) {
    return NextResponse.json({ error: "内容已更新，请获取最新版本后重新生成" }, { status: 409 });
  }

  let resumeContext: string;
  try {
    resumeContext = loadResumeContext(intro.resume_id, intro.resume_version_id);
  } catch (error) {
    if (!(error instanceof ResumeNotFoundError)) throw error;
    return NextResponse.json({ error: "关联的简历已删除，无法重新生成" }, { status: 404 });
  }

  let raw: string;
  try {
    raw = await safeChat(
      "question",
      { feature: LLM_FEATURES.introRegenerate, entity: { type: "intro", id: introId } },
      INTRO_SYSTEM_PROMPT,
      [{ role: "user", parts: buildGenerateUserMessage({ jd: intro.jd, resumeContext, kinds: [kind] }) }],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let sentences: ReturnType<typeof normalizeSentences> = null;
  try {
    const parsed = extractJson<{ versions?: unknown } | null>(raw);
    const found = Array.isArray(parsed?.versions)
      ? parsed.versions.find((version) => version && typeof version === "object" && version.kind === kind)
      : null;
    sentences = normalizeSentences(found?.sentences);
  } catch {
    // 无效 JSON 或结构不完整时由下方统一返回 502。
  }
  if (!sentences) {
    return NextResponse.json({ error: "AI 生成结果异常：缺少有效版本或句子，请重试" }, { status: 502 });
  }

  // 模型等待期间可编辑、删除或恢复数据；提交时必须在同一事务中复核快照。
  const result = saveIntroVersion(introId, kind, revision, sentences);
  if (result.status === 409) {
    return NextResponse.json({ error: "内容已更新或数据已恢复，请基于最新内容重新生成" }, { status: result.status });
  }
  if (result.status === 404) return NextResponse.json({ error: "版本不存在" }, { status: result.status });
  return NextResponse.json({ kind, sentences, revision: result.revision });
}

export const POST = withRouteErrorHandling("POST /api/intros/[id]/regenerate", handlePost);
