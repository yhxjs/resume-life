import { withRouteErrorHandling } from "@/lib/api-route";
import { PreparationInputError, resolvePreparationApplication, linkPreparationResource } from "@/lib/application-preparation";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { checkModelField } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { escapeLike, getDb, inTransaction, now } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { getInterviewStyle, interviewStyleOf } from "@/lib/interview";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { createSseResponse } from "@/lib/sse";
import {
  checkSafeModelInput,
  LLM_FEATURES,
  safeChatStream,
  type PromptPart,
  type SafeMessage,
} from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";

const FIRST_QUESTION_PROMPT = (style: string, persona: string) => {
  if (style === "mining") {
    return `你是经历挖掘访谈官（你的人设：${persona}）。候选人往往只记得“做过这个项目”，但说不清难点、决策和具体贡献。
你的任务是启动经历挖掘的第一阶段【背景与业务痛点】：
请根据【候选人简历】挑选一个重点项目（或结合【岗位要求】挑出最契合的经历），以亲切、启发式的口吻，引导候选人回顾该项目的发起背景：当时团队或业务遇到了什么核心痛点/瓶颈？预期的目标是什么？候选人在其中承担的具体角色是什么？
提示：给出 1-2 个常见业务场景线索帮助打开思路，降低回忆门槛，一次只出一道引导题。
输出 JSON：{"question": "题目文本"}。只输出 JSON。`;
  }
  return `你是面试官（你的人设：${persona}），正在进行一场针对候选人的模拟面试。出题、追问与点评都要符合这个人设。
请根据【岗位要求】与【候选人简历】出第一道面试题。
出题策略：优先从简历上的项目/工作经历深挖，也可结合岗位要求出相关基础题；一次只出一道题。
输出 JSON：{"question": "题目文本"}。只输出 JSON。`;
};

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
  const resumeId = Number(body?.resume_id);
  const jd = typeof body?.jd === "string" ? body.jd.trim() : "";
  const rounds = Math.min(Math.max(Number(body?.rounds) || 8, 1), 30);
  const seriesMode = body?.mode === "series";
  // 进阶模式三轮人设固定（一面技术面/二面主管面/三面 HR 面），首题由一面技术深挖开场
  const style = seriesMode ? "deep" : getInterviewStyle(body?.style);
  if (!Number.isInteger(resumeId)) {
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

  const parts: PromptPart[] = [
    { trust: "trusted", text: "【岗位要求】\n" },
    { trust: "untrusted", tag: "job_description", text: jd },
    { trust: "trusted", text: "\n\n【候选人简历】\n" },
    { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
    { trust: "trusted", text: "\n\n请出第一道面试题。" },
  ];
  const systemPrompt = FIRST_QUESTION_PROMPT(style, interviewStyleOf(style).persona);
  const messages: SafeMessage[] = [{ role: "user", parts }];
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
        (delta) => {
          emitter.sendDelta(delta);
        },
        { signal: emitter.signal, requestId }
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
      const parsed = extractJson<{ question?: unknown }>(raw);
      if (typeof parsed.question === "string" && parsed.question.trim()) {
        question = parsed.question.trim();
      }
    } catch {
      question = "";
    }

    if (!question) {
      emitter.sendError("AI 没有生成有效题目，请重试");
      return;
    }

    const db = getDb();
    const ts = now();
    const { interviewId, seriesId } = inTransaction(() => {
      if (applicationId !== null) resolvePreparationApplication(body, { resumeId, resumeVersionId, jd });
      let newSeriesId: number | null = null;
      if (seriesMode) {
        newSeriesId = Number(
          db
            .prepare("INSERT INTO interview_series (resume_id, resume_version_id, jd, rounds, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(resumeId, resumeVersionId, jd, rounds, ts).lastInsertRowid
        );
      }
      const result = db
        .prepare(
          "INSERT INTO interviews (resume_id, resume_version_id, jd, rounds, style, series_id, round_no, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ongoing', ?)"
        )
        .run(resumeId, resumeVersionId, jd, rounds, style, newSeriesId, seriesMode ? 1 : 0, ts);
      const newId = Number(result.lastInsertRowid);
      db.prepare(
        "INSERT INTO interview_turns (interview_id, idx, kind, question) VALUES (?, 1, 'question', ?)"
      ).run(newId, question);
      if (applicationId !== null) linkPreparationResource(applicationId, newSeriesId === null ? "interview" : "series", newSeriesId ?? newId);
      return { interviewId: newId, seriesId: newSeriesId };
    });

    emitter.sendDone({ id: interviewId, series_id: seriesId, question });
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
