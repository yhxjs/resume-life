import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { getDb, inTransaction, now } from "@/lib/db";
import { checkModelField } from "@/lib/llm-input-budget";
import { LlmConfigError } from "@/lib/llm";
import { errorMessage } from "@/lib/error-message";
import { LlmResponseError } from "@/lib/llm-adapter";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { INTERVIEW_STYLES, getInterviewStyle, type InterviewStyleKey } from "@/lib/interview";
import { checkSafeModelInput, LLM_FEATURES, safeChat } from "@/lib/safe-llm";
import { createSseResponse } from "@/lib/sse";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import {
  INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS,
  INTERVIEW_QUESTION_GRAPH_FRONTIER_LIMIT,
  INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT,
  INTERVIEW_QUESTION_GRAPH_QUESTION_MAX_CHARS,
  type InterviewQuestionGraphFrontier,
  parseInterviewQuestionGraphExpand,
  parseInterviewQuestionGraphPredictions,
  parseInterviewQuestionGraphStart,
  createInterviewQuestionGraphRoot,
  expandInterviewQuestionGraph,
  predictInterviewQuestionGraphAnswers,
  findInterviewQuestionGraphNode,
  collectInterviewQuestionGraphTexts,
  collectInterviewQuestionGraphTextsExcludingDescendants,
  parseInterviewQuestionGraphDocument,
  type InterviewQuestionGraphNode,
} from "@/lib/interview-question-graph";
import { buildInterviewQuestionGraphMessages, interviewQuestionGraphPrompt } from "@/lib/interview-question-graph-llm";
import { ModelProtocolError } from "@/lib/model-protocol";

type GraphRequest = {
  action?: unknown;
  resume_id?: unknown;
  resume_version_id?: unknown;
  jd?: unknown;
  style?: unknown;
  frontier?: unknown;
  known_questions?: unknown;
  graph_id?: unknown;
  revision?: unknown;
};

const MAX_GRAPH_QUESTIONS = 7;
const QUESTION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

class InterviewQuestionGraphConflictError extends Error {}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseTextList(value: unknown, maxItems: number, maxChars: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.length > maxChars) return null;
    result.push(entry.trim());
  }
  if (new Set(result).size !== result.length) return null;
  return result;
}

function parseFrontier(value: unknown, expectedDepth: 2 | 3): InterviewQuestionGraphFrontier[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > INTERVIEW_QUESTION_GRAPH_FRONTIER_LIMIT) return null;
  const result: InterviewQuestionGraphFrontier[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).some((key) => !["question_id", "depth", "question", "parent_question", "answer_scenario"].includes(key))
      || typeof item.question_id !== "string"
      || !QUESTION_ID_PATTERN.test(item.question_id)
      || ids.has(item.question_id)
      || item.depth !== expectedDepth
      || typeof item.question !== "string" || !item.question.trim() || item.question.length > INTERVIEW_QUESTION_GRAPH_QUESTION_MAX_CHARS
      || typeof item.parent_question !== "string" || !item.parent_question.trim() || item.parent_question.length > INTERVIEW_QUESTION_GRAPH_QUESTION_MAX_CHARS
      || typeof item.answer_scenario !== "string" || !item.answer_scenario.trim() || item.answer_scenario.length > INTERVIEW_QUESTION_GRAPH_ANSWER_MAX_CHARS
    ) return null;
    ids.add(item.question_id);
    result.push({
      question_id: item.question_id,
      depth: expectedDepth,
      question: item.question.trim(),
      parent_question: item.parent_question.trim(),
      answer_scenario: item.answer_scenario.trim(),
    });
  }
  return result;
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as GraphRequest | null;
  const action = body?.action;
  const resumeId = body?.resume_id;
  const requestedVersionId = body?.resume_version_id;
  const styleKey = body?.style;
  if (action !== "start" && action !== "expand" && action !== "predict") {
    return NextResponse.json({ error: "图谱操作无效" }, { status: 400 });
  }
  if (!isPositiveId(resumeId) || !isPositiveId(requestedVersionId)) {
    return NextResponse.json({ error: "请选择有效的简历与发布版本" }, { status: 400 });
  }
  const jd = typeof body?.jd === "string" ? body.jd.trim() : "";
  if (!jd) return NextResponse.json({ error: "岗位要求（JD）不能为空" }, { status: 400 });
  if (typeof styleKey !== "string" || !INTERVIEW_STYLES.some((style) => style.key === styleKey)) {
    return NextResponse.json({ error: "请选择有效的面试官风格" }, { status: 400 });
  }
  const style = getInterviewStyle(styleKey) as InterviewStyleKey;
  const frontier = action === "expand" || action === "predict"
    ? parseFrontier(body?.frontier, action === "expand" ? 2 : 3)
    : [];
  if ((action === "expand" || action === "predict") && frontier === null) {
    return NextResponse.json({ error: `每轮最多处理 ${INTERVIEW_QUESTION_GRAPH_FRONTIER_LIMIT} 个有效题目节点` }, { status: 400 });
  }
  if (action === "start" && body?.frontier !== undefined) {
    return NextResponse.json({ error: "首题生成不能包含待扩展节点" }, { status: 400 });
  }
  const knownQuestions = body?.known_questions === undefined
    ? []
    : parseTextList(body.known_questions, MAX_GRAPH_QUESTIONS, INTERVIEW_QUESTION_GRAPH_QUESTION_MAX_CHARS);
  if (knownQuestions === null) return NextResponse.json({ error: "已有题目列表无效" }, { status: 400 });
  if (body !== null && Object.keys(body).some((key) => ![
    "action", "resume_id", "resume_version_id", "jd", "style", "frontier", "known_questions", "graph_id", "revision",
  ].includes(key))) {
    return NextResponse.json({ error: "图谱请求包含未声明字段" }, { status: 400 });
  }
  if (knownQuestions.length > 0 && action === "start") {
    return NextResponse.json({ error: "首题生成不能包含已有题目" }, { status: 400 });
  }

  try {
    checkModelField(jd, "岗位要求（JD）");
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 413 });
  }

  let resumeVersionId: number;
  try {
    resumeVersionId = resolveResumeVersionId(resumeId, requestedVersionId);
  } catch (error) {
    if (error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  let resumeContext: string;
  try {
    resumeContext = loadResumeContext(resumeId, resumeVersionId);
  } catch (error) {
    if (error instanceof ResumeNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    throw error;
  }

  const db = getDb();
  let graphId: number | null = null;
  let graphRevision = 0;
  let storedGraphRoot: InterviewQuestionGraphNode | null = null;
  let storedGraphHistory: InterviewQuestionGraphNode[] = [];
  if (action === "start") {
    if (body?.graph_id !== undefined || body?.revision !== undefined) {
      return NextResponse.json({ error: "新建圖谱不能指定已有记录" }, { status: 400 });
    }
  } else {
    if (!isPositiveId(body?.graph_id) || !Number.isSafeInteger(body?.revision) || (body?.revision as number) < 0) {
      return NextResponse.json({ error: "扩展图谱需要有效的历史记录编号与版本" }, { status: 400 });
    }
    const row = db.prepare(
      "SELECT id, resume_id, resume_version_id, jd, style, graph_json, history_json, revision FROM interview_question_graphs WHERE id = ?",
    ).get(body.graph_id) as {
      id: number;
      resume_id: number;
      resume_version_id: number | null;
      jd: string;
      style: InterviewStyleKey;
      graph_json: string;
      history_json: string;
      revision: number;
    } | undefined;
    if (!row) return NextResponse.json({ error: "题目图谱历史记录不存在" }, { status: 404 });
    if (row.resume_id !== resumeId || row.resume_version_id !== resumeVersionId || row.jd !== jd || row.style !== style) {
      return NextResponse.json({ error: "图谱历史记录与当前简历、岗位或面试风格不一致" }, { status: 409 });
    }
    if (row.revision !== body.revision) return NextResponse.json({ error: "图谱已在其他页面更新，请重新载入历史记录" }, { status: 409 });
    graphId = row.id;
    graphRevision = row.revision;
    storedGraphRoot = parseInterviewQuestionGraphDocument(JSON.parse(row.graph_json) as unknown);
    const parsedHistory: unknown = JSON.parse(row.history_json);
    if (!Array.isArray(parsedHistory) || parsedHistory.length > INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT) {
      return NextResponse.json({ error: "题目图谱历史快照无效" }, { status: 500 });
    }
    storedGraphHistory = parsedHistory.map(parseInterviewQuestionGraphDocument);
    const storedQuestions = collectInterviewQuestionGraphTexts(storedGraphRoot);
    if (knownQuestions.length !== 0 && (knownQuestions.length !== storedQuestions.length || knownQuestions.some((question) => !storedQuestions.includes(question)))) {
      return NextResponse.json({ error: "图谱已在其他页面更新，请重新载入历史记录" }, { status: 409 });
    }
    if ((frontier ?? []).some((item) => {
      const node = findInterviewQuestionGraphNode(storedGraphRoot!, item.question_id);
      return !node || node.depth !== item.depth || (action === "predict" && node.branches.length > 0) || node.question !== item.question ||
        node.parentQuestion !== item.parent_question || node.answerScenario !== item.answer_scenario;
    })) {
      return NextResponse.json({ error: "待处理题目与图谱历史记录不一致，请重新载入" }, { status: 409 });
    }
  }

  const promptKnownQuestions = action === "expand"
    ? collectInterviewQuestionGraphTextsExcludingDescendants(storedGraphRoot!, (frontier ?? []).map((item) => item.question_id))
    : knownQuestions;
  const messages = buildInterviewQuestionGraphMessages({
    action,
    jd,
    resumeContext,
    frontier: frontier ?? [],
    knownQuestions: promptKnownQuestions,
  });
  const systemPrompt = interviewQuestionGraphPrompt(style, action);
  try {
    checkSafeModelInput(systemPrompt, messages);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 413 });
  }

  const requestId = requestIdFrom(req);
  return createSseResponse(async (emitter) => {
    let raw: string;
    try {
      raw = await safeChat("question", { feature: LLM_FEATURES.interviewQuestionGraph, entity: { type: "resume", id: resumeId } }, systemPrompt, messages, {
        signal: emitter.signal,
        requestId,
        requireJson: "strict",
        retryOutputValidationErrors: true,
        validateOutput: (content) => {
          if (action === "start") {
            parseInterviewQuestionGraphStart(content);
          } else if (action === "expand") {
            parseInterviewQuestionGraphExpand(
              content,
              (frontier ?? []).map((item) => item.question_id),
              promptKnownQuestions,
            );
          } else {
            parseInterviewQuestionGraphPredictions(content, (frontier ?? []).map((item) => item.question_id));
          }
        },
      });
    } catch (error) {
      if (emitter.signal.aborted || req.signal.aborted) return;
      if (error instanceof ModelProtocolError) {
        emitter.sendError(`AI 题目图谱异常：${error.message}`);
        return;
      }
      if (error instanceof LlmResponseError && error.code === "provider") {
        const errorId = logServerError("question-graph.llm-provider", error, {
          requestId,
          status: 502,
          context: { task: "question", errorCode: error.code },
        });
        emitter.sendError(`模型服务已连接，但返回了错误响应。请检查服务状态、模型名称、接口格式和 API Key 后重试（${errorId}）`);
        return;
      }
      if (error instanceof TypeError) {
        const errorId = logServerError("question-graph.llm", error, { requestId, status: 502 });
        emitter.sendError(`模型服务连接失败，请检查设置页的服务地址、网络或代理后重试（${errorId}）`);
        return;
      }
      if (!(error instanceof LlmConfigError)) throw error;
      emitter.sendError(error.message);
      return;
    }

    try {
      if (action === "start") {
        const result = parseInterviewQuestionGraphStart(raw);
        const root = createInterviewQuestionGraphRoot(result);
        const graphId = inTransaction(() => {
          emitter.signal.throwIfAborted();
          req.signal.throwIfAborted();
          resolveResumeVersionId(resumeId, resumeVersionId);
          if (loadResumeContext(resumeId, resumeVersionId) !== resumeContext) {
            throw new ResumeVersionError("参考简历或所选发布版本已变化或删除，请核对材料后重新生成", 409);
          }
          const timestamp = now();
          return Number(db.prepare(
            "INSERT INTO interview_question_graphs (resume_id, resume_version_id, jd, style, question, graph_json, history_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', 0, ?, ?)",
          ).run(resumeId, resumeVersionId, jd, style, root.question, JSON.stringify(root), timestamp, timestamp).lastInsertRowid);
        });
        emitter.sendDone({ ...result, graph_id: graphId, revision: 0 });
      } else if (action === "expand") {
        if (graphId === null || !storedGraphRoot) throw new Error("题目图谱历史记录缺失");
        const result = parseInterviewQuestionGraphExpand(
          raw,
          (frontier ?? []).map((item) => item.question_id),
          collectInterviewQuestionGraphTextsExcludingDescendants(storedGraphRoot, (frontier ?? []).map((item) => item.question_id)),
        );
        const root = expandInterviewQuestionGraph(storedGraphRoot, result.expansions);
        const timestamp = now();
        const revision = inTransaction(() => {
          emitter.signal.throwIfAborted();
          req.signal.throwIfAborted();
          resolveResumeVersionId(resumeId, resumeVersionId);
          if (loadResumeContext(resumeId, resumeVersionId) !== resumeContext) {
            throw new ResumeVersionError("参考简历或所选发布版本已变化或删除，请核对材料后重新生成", 409);
          }
          const update = db.prepare(
            "UPDATE interview_question_graphs SET graph_json = ?, history_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
          ).run(JSON.stringify(root), JSON.stringify([...storedGraphHistory, storedGraphRoot].slice(-INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT)), timestamp, graphId, graphRevision);
          if (update.changes !== 1) throw new InterviewQuestionGraphConflictError("图谱已在其他页面更新，请重新载入历史记录");
          return graphRevision + 1;
        });
        emitter.sendDone({ ...result, graph_id: graphId, revision });
      } else {
        if (graphId === null || !storedGraphRoot) throw new Error("题目图谱历史记录缺失");
        const result = parseInterviewQuestionGraphPredictions(raw, (frontier ?? []).map((item) => item.question_id));
        const root = predictInterviewQuestionGraphAnswers(storedGraphRoot, result.predictions);
        const timestamp = now();
        const revision = inTransaction(() => {
          emitter.signal.throwIfAborted();
          req.signal.throwIfAborted();
          resolveResumeVersionId(resumeId, resumeVersionId);
          if (loadResumeContext(resumeId, resumeVersionId) !== resumeContext) {
            throw new ResumeVersionError("参考简历或所选发布版本已变化或删除，请核对材料后重新生成", 409);
          }
          const update = db.prepare(
            "UPDATE interview_question_graphs SET graph_json = ?, history_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
          ).run(JSON.stringify(root), JSON.stringify([...storedGraphHistory, storedGraphRoot].slice(-INTERVIEW_QUESTION_GRAPH_HISTORY_LIMIT)), timestamp, graphId, graphRevision);
          if (update.changes !== 1) throw new InterviewQuestionGraphConflictError("图谱已在其他页面更新，请重新载入历史记录");
          return graphRevision + 1;
        });
        emitter.sendDone({ ...result, graph_id: graphId, revision });
      }
    } catch (error) {
      if (error instanceof ResumeVersionError || error instanceof InterviewQuestionGraphConflictError) {
        emitter.sendError(error.message);
        return;
      }
      if (error instanceof ModelProtocolError) {
        emitter.sendError(`AI 题目图谱异常：${error.message}`);
        return;
      }
      throw error;
    }
  }, requestId);
}

export const POST = withRouteErrorHandling("POST /api/interviews/question-graph", handlePost);
