import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { introVersionRevision, saveIntroVersion, type IntroVersionSnapshot } from "@/lib/intro-versions";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { isIntroKind, normalizeIntroComments, type IntroSentence } from "@/lib/intro";
import { INTRO_COMMENT_SYSTEM_PROMPT, buildCommentUserMessage } from "@/lib/intro-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

/** 对指定版本的当前句子重新逐句点评（句子编辑后点评会置空，用此接口补齐） */
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
  const intro = db.prepare("SELECT jd FROM intros WHERE id = ?").get(introId) as
    | { jd: string }
    | undefined;
  if (!intro) return NextResponse.json({ error: "记录不存在" }, { status: 404 });

  const version = db
    .prepare("SELECT id, sentences, updated_at FROM intro_versions WHERE intro_id = ? AND kind = ?")
    .get(introId, kind) as IntroVersionSnapshot | undefined;
  if (!version) return NextResponse.json({ error: "版本不存在" }, { status: 404 });
  const revision = introVersionRevision(version);
  if (body?.baseRevision !== undefined && body.baseRevision !== revision) {
    return NextResponse.json({ error: "内容已更新，请获取最新版本后重新点评" }, { status: 409 });
  }

  let sentences: IntroSentence[] = [];
  try {
    const parsed = JSON.parse(version.sentences) as unknown;
    if (Array.isArray(parsed)) {
      sentences = parsed.filter(
        (s): s is IntroSentence =>
          !!s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string" && (s as IntroSentence).text.trim() !== ""
      );
    }
  } catch {
    // 走下方空句子分支
  }
  if (sentences.length === 0) {
    return NextResponse.json({ error: "当前版本没有可点评的句子" }, { status: 400 });
  }

  let raw: string;
  try {
    raw = await safeChat(
      "evaluate",
      { feature: LLM_FEATURES.introRecomment, entity: { type: "intro", id: introId } },
      INTRO_COMMENT_SYSTEM_PROMPT,
      [{ role: "user", parts: buildCommentUserMessage({ jd: intro.jd, sentences }) }],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let comments: string[] | null = null;
  try {
    const parsed = extractJson<{ comments?: unknown } | null>(raw);
    if (Array.isArray(parsed?.comments) && parsed.comments.length === sentences.length &&
        parsed.comments.every((comment) => typeof comment === "string" && comment.trim())) {
      comments = normalizeIntroComments(parsed, sentences.length);
    }
  } catch {
    // 无效 JSON 或结构不完整时由下方统一返回 502。
  }
  if (!comments) {
    return NextResponse.json({ error: "AI 点评结果异常：缺少有效点评，请重试" }, { status: 502 });
  }

  // normalizeIntroComments 保证返回长度与句子数一致的字符串数组
  const updated: IntroSentence[] = sentences.map((s, i) => ({ text: s.text, comment: comments[i]! }));
  const result = saveIntroVersion(introId, kind, revision, updated);
  if (result.status !== 200) {
    return NextResponse.json(
      { error: result.status === 409 ? "句子已被修改，请基于最新内容重新点评" : "版本不存在" },
      { status: result.status }
    );
  }
  return NextResponse.json({ kind, sentences: updated, revision: result.revision });
}

export const POST = withRouteErrorHandling("POST /api/intros/[id]/recomment", handlePost);
