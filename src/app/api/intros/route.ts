import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, resolvePreparationApplication, linkPreparationResource } from "@/lib/application-preparation";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { checkModelField } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { IntroResumeContextError, loadIntroResumeContext } from "@/lib/intro-resume-context";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { validateGeneratedIntroVersions } from "@/lib/intro";
import { INTRO_SYSTEM_PROMPT, buildGenerateUserMessage } from "@/lib/intro-llm";
import {
  checkSafeModelInput,
  LLM_FEATURES,
  safeChatStream,
  type PromptPart,
  type SafeMessage,
} from "@/lib/safe-llm";
import { createSseResponse } from "@/lib/sse";
import { errorMessage } from "@/lib/error-message";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";

async function handleGet(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const pagination = parsePaginationParams(searchParams);
  if (!pagination.ok) return pagination.response;
  const { limit, idCursor: cursor } = pagination;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.id, i.jd, i.created_at, COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, i.resume_version_id, rv.version AS resume_version, rv.name AS resume_version_name
       FROM intros i JOIN resumes r ON r.id = i.resume_id LEFT JOIN resume_versions rv ON rv.id = i.resume_version_id
       ${cursor === null ? "" : "WHERE i.id < ?"}
       ORDER BY i.id DESC LIMIT ?`
    )
    .all(...(cursor === null ? [limit + 1] : [cursor, limit + 1])) as { id: number; jd: string; created_at: string; resume_title: string }[];
  const page = createCursorPage(rows, limit, (row) => String(row.id));
  page.total = (db.prepare("SELECT COUNT(*) AS total FROM intros i JOIN resumes r ON r.id = i.resume_id").get() as { total: number }).total;
  return NextResponse.json(page);
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    resume_id?: unknown;
    resume_version_id?: unknown;
    jd?: unknown;
    application_id?: unknown;
  } | null;
  const resumeId = body?.resume_id;
  if (typeof resumeId !== "number" || !Number.isSafeInteger(resumeId) || resumeId <= 0) {
    return NextResponse.json({ error: "请选择简历" }, { status: 400 });
  }
  const jd = typeof body?.jd === "string" ? body.jd.trim() : "";
  if (!jd) {
    return NextResponse.json({ error: "岗位要求（JD）不能为空" }, { status: 400 });
  }
  let applicationId: number | null;
  let resumeVersionId: number;
  try {
    resumeVersionId = resolveResumeVersionId(resumeId, body?.resume_version_id);
    applicationId = resolvePreparationApplication(body, { resumeId, resumeVersionId, jd });
  }
  catch (error) {
    if (error instanceof PreparationInputError || error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  try { checkModelField(jd, "岗位要求（JD）"); }
  catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 413 });
  }

  let resumeContext: string;
  try {
    resumeContext = loadIntroResumeContext(resumeId, resumeVersionId);
  } catch (error) {
    if (error instanceof IntroResumeContextError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (!(error instanceof ResumeNotFoundError)) throw error;
    return NextResponse.json({ error: "简历不存在" }, { status: 404 });
  }

  let parts: PromptPart[];
  let messages: SafeMessage[];
  try {
    parts = buildGenerateUserMessage({ jd, resumeContext, kinds: ["30s", "2min"] });
    messages = [{ role: "user", parts }];
    checkSafeModelInput(INTRO_SYSTEM_PROMPT, messages);
  }
  catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 413 });
  }

  const requestId = requestIdFrom(req);

  return createSseResponse(async (emitter) => {
    let raw: string;
    try {
      raw = await safeChatStream(
        "question",
        { feature: LLM_FEATURES.introGenerate, entity: { type: "resume", id: resumeId } },
        INTRO_SYSTEM_PROMPT,
        messages,
        // 生成协议是 JSON；完整校验并保存前不把临时正文或点评作为页面结果。
        () => {},
        { signal: emitter.signal, requestId, requireJson: "strict" }
      );
    } catch (err) {
      if (err instanceof LlmConfigError) {
        emitter.sendError(err.message);
      } else {
        const loggedId = logServerError("sse.intros.create", err, { requestId, status: 500 });
        emitter.sendError(`服务端处理失败（${loggedId}）`);
      }
      return;
    }

    let versions: ReturnType<typeof validateGeneratedIntroVersions> = null;
    try {
      versions = validateGeneratedIntroVersions(JSON.parse(raw));
    } catch {
      // 格式错误与残缺版本统一报生成异常，不保存部分内容。
    }
    if (!versions) {
      emitter.sendError("AI 生成结果异常：版本、句子或点评不完整，或内容超限，请重试");
      return;
    }

    const db = getDb();
    const ts = now();
    let id: number;
    const contextConflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新生成";
    try {
      id = inTransaction(() => {
        // 固定本次已选发布版；后来发布新版本不换材料，实际依据变化则整组拒绝。
        resolveResumeVersionId(resumeId, resumeVersionId);
        if (loadIntroResumeContext(resumeId, resumeVersionId) !== resumeContext) {
          throw new ResumeVersionError(contextConflict, 409);
        }
        if (applicationId !== null) resolvePreparationApplication(body, { resumeId, resumeVersionId, jd });
        const result = db
          .prepare("INSERT INTO intros (resume_id, resume_version_id, jd, created_at) VALUES (?, ?, ?, ?)")
          .run(resumeId, resumeVersionId, jd, ts);
        const newId = Number(result.lastInsertRowid);
        const insert = db.prepare(
          "INSERT INTO intro_versions (intro_id, kind, sentences, updated_at) VALUES (?, ?, ?, ?)"
        );
        for (const v of versions) insert.run(newId, v.kind, JSON.stringify(v.sentences), ts);
        if (applicationId !== null) linkPreparationResource(applicationId, "intro", newId);
        return newId;
      });
    } catch (error) {
      if (error instanceof ResumeVersionError || error instanceof ResumeNotFoundError || error instanceof IntroResumeContextError) {
        emitter.sendError(contextConflict);
        return;
      }
      if (error instanceof PreparationInputError) {
        emitter.sendError(error.message);
        return;
      }
      throw error;
    }

    emitter.sendDone({ id });
  }, requestId);
}

export const GET = withRouteErrorHandling("GET /api/intros", handleGet);
export const POST = withRouteErrorHandling("POST /api/intros", handlePost);
