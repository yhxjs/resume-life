import { acquireCommandLock, getDb, inTransaction } from "@/lib/db";
import { DataGenerationConflictError } from "@/lib/data-generation";
import { interviewStyleOf } from "@/lib/interview";
import { LlmConfigError } from "@/lib/llm";
import { checkModelField } from "@/lib/llm-input-budget";
import {
  ModelProtocolError,
  parseInterviewAnswerDecision,
} from "@/lib/model-protocol";
import { captureInterviewResumeContext } from "@/lib/interview-resume-context";
import { checkSafeModelInput, LLM_FEATURES, safeChatStream } from "@/lib/safe-llm";
import type { SseEmitter } from "@/lib/sse";
import { InterviewCommandError } from "./errors";
import { errorMessage } from "@/lib/error-message";
import { logServerError } from "@/lib/server-errors";
import { commitInterviewTurn } from "@/lib/interview-session-store";
import { loadPriorSeriesContext } from "./series-context";
import { questionComparisonKey } from "@/lib/question-normalization";
import { buildInterviewAnswerMessages, interviewAnswerPrompt } from "@/lib/interview-answer-llm";

export type AnswerInterviewExecution = (emitter: SseEmitter) => Promise<void>;

export function prepareAnswerInterview(args: {
  interviewId: number;
  turnId: number;
  answer: string;
  requestSignal: AbortSignal;
  requestId?: string;
}): AnswerInterviewExecution {
  const { interviewId, turnId, answer, requestSignal, requestId } = args;
  try { checkModelField(answer, "回答"); }
  catch (error) { throw new InterviewCommandError(errorMessage(error), 413); }
  const db = getDb();
  const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, style, series_id, round_no, status FROM interviews WHERE id = ?");
  const interview = interviewQuery.get(interviewId) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; rounds: number; style: string; series_id: number | null; round_no: number; status: string }
    | undefined;
  if (!interview) throw new InterviewCommandError("面试不存在", 404);
  if (interview.status !== "ongoing") throw new InterviewCommandError("面试已结束", 400);
  const turnQuery = db.prepare("SELECT id, idx, question FROM interview_turns WHERE id = ? AND interview_id = ? AND answered_at = ''");
  const turn = turnQuery.get(turnId, interviewId) as { id: number; idx: number; question: string } | undefined;
  if (!turn) throw new InterviewCommandError("该题已作答或不存在", 400);
  const resumeMaterial = captureInterviewResumeContext(interview.resume_id, interview.resume_version_id, "（简历已删除）");
  const resumeContext = resumeMaterial.text;
  const historyQuery = db.prepare("SELECT id, idx, kind, question, answer FROM interview_turns WHERE interview_id = ? AND answered_at != '' ORDER BY idx, id");
  const history = historyQuery.all(interviewId) as { id: number; idx: number; kind: string; question: string; answer: string }[];
  const priorContext = interview.series_id !== null && interview.round_no > 1
    ? loadPriorSeriesContext(interview.series_id, interview.round_no) : null;
  const finalTurn = turn.idx >= interview.rounds;
  const askedQuestions = new Set([turn.question, ...history.map((item) => item.question)].map(questionComparisonKey));
  const systemPrompt = interviewAnswerPrompt(interviewStyleOf(interview.style).persona, interview.style, finalTurn, priorContext !== null)
  const messages = buildInterviewAnswerMessages({
    jd: interview.jd,
    resumeContext,
    priorSeriesParts: priorContext?.parts,
    history,
    current: { idx: turn.idx, question: turn.question },
    answer,
  });
  try {
    checkModelField(interview.jd, "岗位要求（JD）");
    checkSafeModelInput(systemPrompt, messages);
  } catch (error) {
    throw new InterviewCommandError(errorMessage(error), 413);
  }
  const release = acquireCommandLock(`interview-answer:${interviewId}`);
  if (!release) throw new InterviewCommandError("本场面试正在处理回答，请稍后重试", 409);

  return async (emitter) => {
    try {
      let raw: string;
      try {
        raw = await safeChatStream("evaluate", { feature: LLM_FEATURES.seriesAnswerGrade, entity: { type: "interview", id: interviewId } }, systemPrompt, messages, () => {}, {
          signal: emitter.signal,
          requestId,
          requireJson: "strict"
        });
      }
      catch (error) {
        if (error instanceof LlmConfigError || error instanceof DataGenerationConflictError) {
          emitter.sendError(error.message);
        } else {
          const loggedId = logServerError("sse.interviews.answer", error, { requestId, status: 500 });
          emitter.sendError(`服务端处理失败（${loggedId}）`);
        }
        return;
      }
      let parsed;
      try {
        parsed = parseInterviewAnswerDecision(raw, { finalTurn });
        if (!finalTurn && askedQuestions.has(questionComparisonKey(parsed.next_question))) {
          throw new ModelProtocolError("AI 下一题与当前题或本场已答题重复，请重试");
        }
        if (!finalTurn && priorContext?.questions.has(questionComparisonKey(parsed.next_question))) {
          throw new ModelProtocolError("AI 下一题与本进阶面试的前轮原题重复，请重试");
        }
      }
      catch (error) {
        if (error instanceof ModelProtocolError) {
          emitter.sendError(`AI 评分结果协议错误：${error.message}`);
        } else {
          const loggedId = logServerError("sse.interviews.answer", error, { requestId, status: 500 });
          emitter.sendError(`服务端处理失败（${loggedId}）`);
        }
        return;
      }
      const scores = {
        depth: parsed.depth,
        structure: parsed.structure,
        authenticity: parsed.authenticity,
        completeness: parsed.completeness,
      };
      const comment = parsed.comment;
      const nextKind = parsed.next_kind;
      const nextQuestion = parsed.next_question;
      const finished = finalTurn;
      const contextConflict = "面试资料、当前题目或上下文已变化，请重新读取面试状态后再提交";
      try {
        inTransaction(() => {
          emitter.signal.throwIfAborted();
          requestSignal.throwIfAborted();
          // 等待模型时不持事务；只复核实际评分依据，旧点评/评分和未提供的原答不参与比较。
          if (JSON.stringify(interviewQuery.get(interviewId)) !== JSON.stringify(interview) ||
              JSON.stringify(turnQuery.get(turnId, interviewId)) !== JSON.stringify(turn) ||
              JSON.stringify(historyQuery.all(interviewId)) !== JSON.stringify(history) ||
              !resumeMaterial.isCurrent() ||
              (interview.series_id !== null && priorContext !== null && JSON.stringify(loadPriorSeriesContext(interview.series_id, interview.round_no).parts) !== JSON.stringify(priorContext.parts))) {
            throw new InterviewCommandError(contextConflict, 409);
          }
          commitInterviewTurn({ interviewId, turn, answer, comment, scores, nextKind, nextQuestion, finished });
        });
      } catch (error) {
        if (!(error instanceof InterviewCommandError)) throw error;
        emitter.sendError(error.message);
        return;
      }
      // The UI shows readable feedback only after protocol and persistence checks pass.
      emitter.sendDelta(comment);
      emitter.sendDone({ scores, comment, next_question: nextQuestion, next_kind: nextKind, finished, natural_finished: finished });
    } finally {
      release();
    }
  };
}
