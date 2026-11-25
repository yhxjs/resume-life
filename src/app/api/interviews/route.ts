import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, resolvePreparationApplication, linkPreparationResource } from "@/lib/application-preparation";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { checkModelField } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { escapeLike, getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { DEFAULT_INTERVIEW_ROUNDS, INTERVIEW_ROUNDS_ERROR, isInterviewRounds, getInterviewStyle, interviewStyleOf } from "@/lib/interview";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeContextError, ResumeNotFoundError } from "@/lib/resume-errors";
import { createSseResponse } from "@/lib/sse";
import {
  checkSafeModelInput,
  LLM_FEATURES,
  safeChatStream,
} from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";
import { ModelProtocolError, validateInterviewQuestion } from "@/lib/model-protocol";
import { buildFirstInterviewQuestionMessages, firstInterviewQuestionPrompt } from "@/lib/interview-question-llm";
import { createInterviewSession } from "@/lib/interview-session-store";

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    resume_id?: unknown;
    resume_version_id?: unknown;
    jd?: unknown;
    rounds?: unknown;
    style?: unknown;
    mode?: unknown;
    application_id?: unknown;
  } | null;
  const resumeId = body?.resume_id;
  const jd = typeof body?.jd === "string" ? body.jd.trim() : "";
  const rounds = body?.rounds === undefined ? DEFAULT_INTERVIEW_ROUNDS : body.rounds;
  if (!isInterviewRounds(rounds)) return NextResponse.json({ error: INTERVIEW_ROUNDS_ERROR }, { status: 400 });
  const seriesMode = body?.mode === "series";
  // 进阶模式三轮人设固定（一面技术面/二面主管面/三面 HR 面），首题由一面技术深挖开场
  const style = seriesMode ? "deep" : getInterviewStyle(body?.style);
  if (typeof resumeId !== "number" || !Number.isSafeInteger(resumeId) || resumeId <= 0) {
    return NextResponse.json({ error: "请选择简历" }, { status: 400 });
  }
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
    resumeContext = loadResumeContext(resumeId, resumeVersionId);
  } catch (err) {
    if (!(err instanceof ResumeNotFoundError)) throw err;
    return NextResponse.json({ error: errorMessage(err) }, { status: 404 });
  }

  const systemPrompt = firstInterviewQuestionPrompt(style, interviewStyleOf(style).persona);
  const messages = buildFirstInterviewQuestionMessages(jd, resumeContext);
  try { checkSafeModelInput(systemPrompt, messages); }
  catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 413 });
  }

  const requestId = requestIdFrom(req);

  return createSseResponse(async (emitter) => {
    let raw: string;
    try {
      raw = await safeChatStream(
        "question",
        { feature: LLM_FEATURES.interviewCreate, entity: { type: "resume", id: resumeId } },
        systemPrompt,
        messages,
        () => {},
        {
          signal: emitter.signal,
          requestId,
          requireJson: "strict"
        }
      );
    } catch (err) {
      if (err instanceof LlmConfigError) {
        emitter.sendError(err.message);
      } else {
        const loggedId = logServerError("sse.interviews.create", err, { requestId, status: 500 });
        emitter.sendError(`服务端处理失败（${loggedId}）`);
      }
      return;
    }

    let question = "";
    try {
      const parsed: { question?: unknown } = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "question")) {
        throw new ModelProtocolError("AI 出题结果包含未声明字段");
      }
      question = validateInterviewQuestion(parsed.question);
    } catch (error) {
      emitter.sendError(error instanceof ModelProtocolError ? error.message : "AI 没有生成有效题目，请重试");
      return;
    }

    const db = getDb();
    const ts = now();
    const contextConflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新生成";
    let created: { interviewId: number; seriesId: number | null };
    try {
      created = inTransaction(() => {
        emitter.signal.throwIfAborted();
        req.signal.throwIfAborted();
        // 本次已固定发布版；提交时只复核实际职业材料，不改用后来发布的版本。
        resolveResumeVersionId(resumeId, resumeVersionId);
        if (loadResumeContext(resumeId, resumeVersionId) !== resumeContext) {
          throw new ResumeVersionError(contextConflict, 409);
        }
        if (applicationId !== null) resolvePreparationApplication(body, { resumeId, resumeVersionId, jd });
        let newSeriesId: number | null = null;
        if (seriesMode) {
          newSeriesId = Number(
            db
              .prepare("INSERT INTO interview_series (resume_id, resume_version_id, jd, rounds, created_at) VALUES (?, ?, ?, ?, ?)")
              .run(resumeId, resumeVersionId, jd, rounds, ts).lastInsertRowid
          );
        }
        const newId = createInterviewSession({ resumeId, versionId: resumeVersionId, jd, rounds, style, seriesId: newSeriesId,
          roundNo: seriesMode ? 1 : 0, question, at: ts });
        if (applicationId !== null) linkPreparationResource(applicationId, newSeriesId === null ? "interview" : "series", newSeriesId ?? newId);
        return { interviewId: newId, seriesId: newSeriesId };
      });
    } catch (error) {
      if (error instanceof ResumeVersionError || error instanceof ResumeNotFoundError || error instanceof ResumeContextError) {
        emitter.sendError(contextConflict);
        return;
      }
      if (error instanceof PreparationInputError) {
        emitter.sendError(error.message);
        return;
      }
      throw error;
    }

    // Only expose a validated, persisted question to the typewriter.
    emitter.sendDelta(question);
    emitter.sendDone({ id: created.interviewId, series_id: created.seriesId, question });
  }, requestId);
}

async function handleGet(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const page = parsePaginationParams(searchParams);
  if (!page.ok) return page.response;
  const { limit, idCursor: cursor } = page;
  const q = (searchParams.get("q") ?? "").trim();

  // 单轮面试列表：进阶面试的各轮由 series 列表统一呈现
  const conditions: string[] = ["i.series_id IS NULL"];
  const params: (string | number)[] = [];
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      `(i.jd LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM interview_turns t2
         WHERE t2.interview_id = i.id
           AND (t2.question LIKE ? ESCAPE '\\' OR t2.answer LIKE ? ESCAPE '\\')))`
    );
    params.push(like, like, like, like);
  }
  if (cursor !== null) {
    conditions.push("i.id < ?");
    params.push(cursor);
  }
  params.push(limit + 1);

  const db = getDb();
  const { total } = db.prepare("SELECT COUNT(*) AS total FROM interviews WHERE series_id IS NULL").get() as { total: number };
  const rows = db
    .prepare(
      `SELECT i.id, i.jd, i.rounds, i.style, i.status, i.created_at, COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, i.resume_version_id, rv.version AS resume_version, rv.name AS resume_version_name,
              (SELECT COUNT(*) FROM interview_turns t WHERE t.interview_id = i.id AND t.answered_at != '') AS answered
       FROM interviews i
       JOIN resumes r ON r.id = i.resume_id LEFT JOIN resume_versions rv ON rv.id = i.resume_version_id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY i.id DESC
       LIMIT ?`
    )
    .all(...params) as {
    id: number;
    jd: string;
    rounds: number;
    style: string;
    status: string;
    created_at: string;
    resume_title: string;
    answered: number;
  }[];
  return NextResponse.json({ ...createCursorPage(rows, limit, (row) => String(row.id)), total });
}

export const GET = withRouteErrorHandling("GET /api/interviews", handleGet);
export const POST = withRouteErrorHandling("POST /api/interviews", handlePost);
