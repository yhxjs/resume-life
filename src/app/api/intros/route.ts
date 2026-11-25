import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, resolvePreparationApplication, linkPreparationResource } from "@/lib/application-preparation";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { checkModelField } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { createIntroRecord } from "@/lib/intro-store";
import { LlmConfigError, LlmTimeoutError } from "@/lib/llm";
import { LlmResponseError } from "@/lib/llm-adapter";
import { IntroResumeContextError, loadIntroResumeContext } from "@/lib/intro-resume-context";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { INTRO_KINDS, validateGeneratedIntroVersions, type IntroKind } from "@/lib/intro";
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
import { logServerError, logServerEvent, requestIdFrom } from "@/lib/server-errors";
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
    const generate = async (kinds: IntroKind[], input: SafeMessage[]) => {
      emitter.signal.throwIfAborted();
      const raw = await safeChatStream(
        "question",
        { feature: LLM_FEATURES.introGenerate, entity: { type: "resume", id: resumeId } },
        INTRO_SYSTEM_PROMPT,
        input,
        // 生成协议是 JSON；完整校验并保存前不把临时正文或点评作为页面结果。
        () => {},
        {
          signal: emitter.signal,
          requestId,
          requireJson: "strict"
        }
      );
      try {
        return validateGeneratedIntroVersions(JSON.parse(raw), kinds);
      } catch {
        return null;
      }
    };

    let versions: ReturnType<typeof validateGeneratedIntroVersions>;
    try {
      try {
        versions = await generate([...INTRO_KINDS], messages);
      } catch (error) {
        // 仅输出上限触发一次分版恢复，沿用用户配置的预算与原始材料。
        // 截断内容全部丢弃；两版都通过校验后才进入下面的保存事务。
        if (!(error instanceof LlmResponseError) || error.code !== "incomplete" ||
            error.reason !== "output_limit" || emitter.signal.aborted) throw error;
        logServerEvent("info", "sse.intros.split", { requestId, context: { errorCode: "output_limit" } });
        versions = [];
        for (const kind of INTRO_KINDS) {
          const single = await generate([kind], [{
            role: "user", parts: buildGenerateUserMessage({ jd, resumeContext, kinds: [kind] }),
          }]);
          if (!single) { versions = null; break; }
          versions.push(...single);
        }
      }
    } catch (err) {
      if (err instanceof LlmConfigError) {
        emitter.sendError(err.message, { outcome: "not_saved" });
      } else {
        const loggedId = logServerError("sse.intros.create", err, {
          requestId, status: 500,
          ...(err instanceof LlmResponseError ? { context: { errorCode: err.reason ?? err.code } } : {}),
        });
        const message = err instanceof LlmResponseError
          ? err.reason === "output_limit"
            ? "分版生成仍达到模型输出上限，请前往「设置」调大最大输出 token 后重试"
            : err.reason === "context_limit"
              ? "材料超出模型上下文上限，请精简材料后重试"
              : err.reason === "interrupted"
                ? "模型服务连接中断，未收到完整响应，请检查模型网关后重试"
              : err.reason === "content_filter" || err.reason === "refusal"
                ? "模型服务拒绝生成自我介绍，请核对材料或更换模型后重试"
                : "模型服务未返回完整有效的自我介绍，请重试或检查模型设置"
          : err instanceof LlmTimeoutError ? "生成自我介绍超时，请重试或检查模型设置" : "服务端处理失败";
        emitter.sendError(`${message}（${loggedId}）；本次未保存自我介绍。`, { outcome: "not_saved" });
      }
      return;
    }

    if (!versions) {
      emitter.sendError("AI 生成结果异常：版本、句子或点评不完整，或内容超限，本次未保存，请重试", { outcome: "not_saved" });
      return;
    }

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
        const newId = createIntroRecord({ resumeId, versionId: resumeVersionId, jd, resumeContext, versions });
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
