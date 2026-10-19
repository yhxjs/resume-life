import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { interviewStyleOf, type InterviewStyleKey } from "@/lib/interview";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { normalizeReport } from "@/lib/scores";
import { SERIES_ROUNDS, seriesRoundOf } from "@/lib/series";
import { InterviewCommandError } from "./errors";
import { errorMessage } from "@/lib/error-message";

const SERIES_FIRST_PROMPT = (persona: string) => `你是面试官（你的人设：${persona}），正在主持候选人的进阶面试（共 ${SERIES_ROUNDS} 轮：一面技术面、二面主管面、三面 HR 面）。出题、追问与点评都要符合这个人设。
若提供了前几轮反馈，请针对其中暴露的短板与存疑之处换角度考察验证，避免重复前轮已问过的原题。请根据【岗位要求】与【候选人简历】出第一道面试题。
出题策略：优先从简历上的项目/工作经历深挖，也可结合岗位要求出相关基础题；一次只出一道题。
输出 JSON：{"question": "题目文本"}。只输出 JSON。`;

function priorFeedbackText(seriesId: number, beforeRound: number): string {
  const rows = getDb().prepare(
    "SELECT round_no, style, report FROM interviews WHERE series_id = ? AND round_no < ? AND report != '' ORDER BY round_no"
  ).all(seriesId, beforeRound) as { round_no: number; style: string; report: string }[];
  return rows.map((row) => {
    try {
      const report = normalizeReport(JSON.parse(row.report));
      if (!report) return "";
      return `第${row.round_no}轮（${interviewStyleOf(row.style).label}，总分 ${report.overall}）：强项 ${report.strengths}；短板 ${report.weaknesses}；建议 ${report.suggestions}`;
    } catch { return ""; }
  }).filter(Boolean).join("\n");
}

export async function advanceSeries(seriesId: number, signal: AbortSignal): Promise<{ id: number; round_no: number }> {
  const db = getDb();
  const series = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, status, final_report FROM interview_series WHERE id = ?").get(seriesId) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; rounds: number; status: string; final_report: string }
    | undefined;
  if (!series) throw new InterviewCommandError("进阶面试不存在", 404);
  if (series.status !== "ongoing" || series.final_report) throw new InterviewCommandError("三轮已全部完成且总评已生成", 400);
  const last = db.prepare("SELECT round_no, status, report FROM interviews WHERE series_id = ? ORDER BY round_no DESC LIMIT 1").get(seriesId) as
    | { round_no: number; status: string; report: string }
    | undefined;
  if (!last) throw new InterviewCommandError("一面尚未开始", 400);
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
  const priorFeedback = priorFeedbackText(seriesId, nextNo);
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
        [{
          role: "user",
          parts: [
            { trust: "trusted", text: "【当前轮次】\n" },
            { trust: "untrusted", tag: "interview_round", text: String(nextNo) },
            { trust: "trusted", text: "\n\n" },
            { trust: "trusted", text: "【岗位要求】\n" },
            { trust: "untrusted", tag: "job_description", text: series.jd },
            { trust: "trusted", text: "\n\n【候选人简历】\n" },
            { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
            ...(priorFeedback
              ? [
                  { trust: "trusted", text: "\n\n【前几轮反馈】\n" } as const,
                  { trust: "untrusted", tag: "prior_interview_feedback", text: priorFeedback } as const,
                ]
              : []),
            { trust: "trusted", text: "\n\n请出第一道面试题。" },
          ],
        }],
        { signal, requireJson: true },
      );
    } catch (error) {
      const status = error instanceof ModelInputBudgetError ? 413 : 502;
      const message = error instanceof LlmConfigError ? error.message : errorMessage(error);
      throw new InterviewCommandError(message, status);
    }
    let question = "";
    try {
      const parsed = extractJson<{ question?: unknown }>(raw);
      if (typeof parsed.question === "string" && parsed.question.trim()) question = parsed.question.trim();
    } catch { question = ""; }
    if (!question) throw new InterviewCommandError("AI 没有生成有效题目，请重试", 502);

    const interviewId = inTransaction(() => {
      signal.throwIfAborted();
      const current = db.prepare(`UPDATE interview_series SET status = status WHERE id = ? AND status = 'ongoing' AND final_report = ''
        AND EXISTS (SELECT 1 FROM interviews WHERE series_id = ? AND round_no = ? AND status = 'finished' AND report = ?)
        AND NOT EXISTS (SELECT 1 FROM interviews WHERE series_id = ? AND round_no >= ?)`)
        .run(seriesId, seriesId, last.round_no, last.report, seriesId, nextNo);
      if (current.changes !== 1) return null;
      const result = db.prepare(
        "INSERT INTO interviews (resume_id, resume_version_id, jd, rounds, style, series_id, round_no, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'ongoing', ?)"
      ).run(series.resume_id, series.resume_version_id, series.jd, series.rounds, style, seriesId, nextNo, now());
      const newId = Number(result.lastInsertRowid);
      db.prepare("INSERT INTO interview_turns (interview_id, idx, kind, question) VALUES (?, 1, 'question', ?)").run(newId, question);
      return newId;
    });
    if (interviewId === null) throw new InterviewCommandError("进阶面试状态已变更，请刷新后重试", 409);
    return { id: interviewId, round_no: nextNo };
  } finally {
    release();
  }
}
