import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { interviewStyleOf, type InterviewStyleKey } from "@/lib/interview";
import { LlmConfigError } from "@/lib/llm";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { ModelProtocolError } from "@/lib/model-protocol";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeContextError, ResumeNotFoundError } from "@/lib/resume-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { SERIES_ROUNDS, seriesRoundOf } from "@/lib/series";
import { InterviewCommandError } from "./errors";
import { errorMessage } from "@/lib/error-message";
import { loadPriorSeriesContext } from "./series-context";
import { parseSeriesAdvanceQuestion, SERIES_FIRST_PROMPT, buildSeriesAdvanceMessages } from "@/lib/interview-series-advance-llm";

export async function advanceSeries(seriesId: number, fromInterviewId: number, signal: AbortSignal): Promise<{ id: number; round_no: number }> {
  if (!Number.isSafeInteger(fromInterviewId) || fromInterviewId <= 0) throw new InterviewCommandError("请指定有效的上一轮面试 ID", 400);
  const db = getDb();
  const seriesQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, status, final_report FROM interview_series WHERE id = ?");
  const series = seriesQuery.get(seriesId) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; rounds: number; status: string; final_report: string }
    | undefined;
  if (!series) throw new InterviewCommandError("进阶面试不存在", 404);
  const source = db.prepare("SELECT id, round_no, status, report FROM interviews WHERE id = ? AND series_id = ?").get(fromInterviewId, seriesId) as
    | { id: number; round_no: number; status: string; report: string }
    | undefined;
  if (!source || !Number.isSafeInteger(source.round_no) || source.round_no < 1 || source.round_no >= SERIES_ROUNDS) {
    throw new InterviewCommandError("上一轮面试不属于本系列或不可继续推进，请刷新后重试", 409);
  }
  if (source.status !== "finished" || !source.report) throw new InterviewCommandError("请先结束上一轮并生成该轮总结报告", 400);
  // 请求始终绑定原定下一轮。已有结果直接返回，即使其他页面已完成后续轮次或总评。
  const existing = db.prepare("SELECT id, round_no FROM interviews WHERE series_id = ? AND round_no = ?").get(seriesId, source.round_no + 1) as
    | { id: number; round_no: number }
    | undefined;
  if (existing) return existing;
  if (series.status !== "ongoing" || series.final_report) throw new InterviewCommandError("三轮已全部完成且总评已生成", 400);
  const last = db.prepare("SELECT id, round_no, status, report FROM interviews WHERE series_id = ? ORDER BY round_no DESC LIMIT 1").get(seriesId) as
    | { id: number; round_no: number; status: string; report: string }
    | undefined;
  if (!last) throw new InterviewCommandError("一面尚未开始", 400);
  if (last.id !== source.id) throw new InterviewCommandError("系列轮次已变更，请刷新后重试", 409);
  if (last.round_no >= SERIES_ROUNDS) throw new InterviewCommandError("三轮已全部完成，可生成总评", 400);
  if (last.status !== "finished" || !last.report) throw new InterviewCommandError("请先结束上一轮并生成该轮总结报告", 400);
  const nextNo = last.round_no + 1;
  const roundDef = seriesRoundOf(nextNo);
  if (!roundDef) throw new InterviewCommandError("无效的轮次", 400);
  let resumeContext: string;
  try { resumeContext = loadResumeContext(series.resume_id, series.resume_version_id); }
  catch (error) {
    if (!(error instanceof ResumeNotFoundError)) throw error;
    throw new InterviewCommandError(errorMessage(error), 400);
  }
  const priorContext = loadPriorSeriesContext(seriesId, nextNo);
  const style: InterviewStyleKey = roundDef.style;
  const release = acquireCommandLock(`interview-series:${seriesId}`);
  if (!release) throw new InterviewCommandError("正在创建下一轮，请稍后重试", 409);
  try {
    let raw: string;
    try {
      checkModelField(series.jd, "岗位要求（JD）");
      raw = await safeChat(
        "question",
        { feature: LLM_FEATURES.seriesAdvance, entity: { type: "interview_series", id: seriesId } },
        SERIES_FIRST_PROMPT(interviewStyleOf(style).persona),
        buildSeriesAdvanceMessages({ roundNo: nextNo, jd: series.jd, resumeContext, priorParts: priorContext.parts }),
        { signal, requireJson: "strict" },
      );
    } catch (error) {
      const status = error instanceof ModelInputBudgetError ? 413 : 502;
      const message = error instanceof LlmConfigError ? error.message : errorMessage(error);
      throw new InterviewCommandError(message, status);
    }
    let question = "";
    try {
      question = parseSeriesAdvanceQuestion(raw, priorContext.questions);
    } catch (error) {
      throw new InterviewCommandError(error instanceof ModelProtocolError ? error.message : "AI 没有生成有效题目，请重试", 502);
    }

    const interviewId = inTransaction(() => {
      signal.throwIfAborted();
      // 模型等待期间不持有事务；提交前核对实际使用的岗位、轮次参数和前轮材料。
      if (JSON.stringify(seriesQuery.get(seriesId)) !== JSON.stringify(series) ||
          JSON.stringify(loadPriorSeriesContext(seriesId, nextNo).parts) !== JSON.stringify(priorContext.parts)) return null;
      const contextConflict = "参考简历或所选发布版本已变化或删除，请核对材料后重新推进";
      try {
        if (loadResumeContext(series.resume_id, series.resume_version_id) !== resumeContext) {
          throw new InterviewCommandError(contextConflict, 409);
        }
      } catch (error) {
        if (error instanceof ResumeNotFoundError || error instanceof ResumeContextError) throw new InterviewCommandError(contextConflict, 409);
        throw error;
      }
      const current = db.prepare(`UPDATE interview_series SET status = status WHERE id = ? AND status = 'ongoing' AND final_report = ''
        AND EXISTS (SELECT 1 FROM interviews WHERE series_id = ? AND id = ? AND round_no = ? AND status = 'finished' AND report = ?)
        AND NOT EXISTS (SELECT 1 FROM interviews WHERE series_id = ? AND round_no >= ?)`)
        .run(seriesId, seriesId, last.id, last.round_no, last.report, seriesId, nextNo);
      if (current.changes !== 1) return null;
      const result = db.prepare(
        "INSERT INTO interviews (resume_id, resume_version_id, jd, rounds, style, series_id, round_no, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ongoing', ?)"
      ).run(series.resume_id, series.resume_version_id, series.jd, series.rounds, style, seriesId, nextNo, now());
      const newId = Number(result.lastInsertRowid);
      db.prepare("INSERT INTO interview_turns (interview_id, idx, kind, question) VALUES (?, 1, 'question', ?)").run(newId, question);
      return newId;
    });
    if (interviewId === null) throw new InterviewCommandError("进阶面试资料、状态或前轮材料已变更，请刷新后重试", 409);
    return { id: interviewId, round_no: nextNo };
  } finally {
    release();
  }
}
