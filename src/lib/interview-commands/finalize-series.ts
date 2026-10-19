import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { interviewStyleOf } from "@/lib/interview";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { safeChat, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";
import { normalizeReport, type InterviewReport } from "@/lib/scores";
import { normalizeSeriesReport, SERIES_ROUNDS, type SeriesReport } from "@/lib/series";
import { InterviewCommandError } from "./errors";
import { errorMessage } from "@/lib/error-message";

const FINAL_PROMPT = `你是面试组组长。候选人为同一岗位完成了${SERIES_ROUNDS}轮进阶面试：第 1 轮技术面（技术深挖）、第 2 轮主管面（方案权衡与取舍）、第 3 轮 HR 面（动机与行为）。请基于${SERIES_ROUNDS}轮的总结报告输出跨轮总评：综合判断三轮表现的一致性与变化（如技术面展现的深度与主管面考察的决策力是否互相印证、HR 面反映的动机与前两轮表现是否匹配），指出贯穿性优势与短板。输出 JSON：{"verdict": "综合结论，3-5 句，可分轮点评", "strengths": "跨轮强项，2-3 句", "weaknesses": "跨轮短板，2-3 句", "suggestions": "综合改进建议，2-4 句"}。只输出 JSON。`;

type StoredRound = { round_no: number; style: string; report: string };

export async function finalizeSeries(seriesId: number, signal: AbortSignal): Promise<{ report: SeriesReport; finished_at: string }> {
  const db = getDb();
  const series = db.prepare("SELECT id, jd, status, final_report FROM interview_series WHERE id = ?").get(seriesId) as
    | { id: number; jd: string; status: string; final_report: string }
    | undefined;
  if (!series) throw new InterviewCommandError("进阶面试不存在", 404);
  if (series.final_report) throw new InterviewCommandError("总评已生成", 400);
  if (series.status !== "ongoing") throw new InterviewCommandError("进阶面试状态已变更，请刷新后重试", 409);

  const rounds = db
    .prepare("SELECT round_no, style, report FROM interviews WHERE series_id = ? AND report != '' ORDER BY round_no")
    .all(seriesId) as StoredRound[];
  const reports: { round_no: number; style: string; report: InterviewReport; raw: string }[] = [];
  for (const row of rounds) {
    let report: InterviewReport | null = null;
    try { report = normalizeReport(JSON.parse(row.report)); }
    catch { report = null; }
    if (!report) throw new InterviewCommandError("该轮报告数据异常，请重新生成该轮报告", 400);
    reports.push({ round_no: row.round_no, style: row.style, report, raw: row.report });
  }
  if (
    reports.length !== SERIES_ROUNDS
    || reports.some((item, index) => item.round_no !== index + 1)
  ) {
    throw new InterviewCommandError("三轮报告必须恰好包含第 1 至第 3 轮，请检查轮次数据后重试", 400);
  }

  const overall = Math.round((reports.reduce((sum, item) => sum + item.report.overall, 0) / reports.length) * 10) / 10;
  const roundLines = reports.map(({ round_no, style, report }) => {
    const label = interviewStyleOf(style).label;
    return `第${round_no}轮 ${label}：总分 ${report.overall}（技术深度 ${report.depth}、结构表达 ${report.structure}、真实性 ${report.authenticity}、完整度 ${report.completeness}、岗位匹配 ${report.jd_match}）\n强项：${report.strengths}\n短板：${report.weaknesses}\n建议：${report.suggestions}`;
  });
  const roundParts: PromptPart[] = roundLines.flatMap((round, index) => [
    ...(index > 0 ? [{ trust: "trusted", text: "\n\n" } as const] : []),
    { trust: "untrusted", tag: "round_report", text: round } as const,
  ]);

  const release = acquireCommandLock(`interview-series:${seriesId}`);
  if (!release) throw new InterviewCommandError("正在生成跨轮总评，请稍后重试", 409);
  try {
    let raw: string;
    try {
      checkModelField(series.jd, "岗位要求（JD）");
      raw = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.seriesFinalize, entity: { type: "interview_series", id: seriesId } },
        FINAL_PROMPT,
        [{
          role: "user",
          parts: [
            { trust: "trusted", text: "【岗位要求】\n" },
            { trust: "untrusted", tag: "job_description", text: series.jd },
            { trust: "trusted", text: "\n\n【三轮总结报告】\n" },
            ...roundParts,
            { trust: "trusted", text: "\n\n请输出跨轮总评。" },
          ],
        }],
        { signal, requireJson: true },
      );
    } catch (error) {
      const status = error instanceof ModelInputBudgetError ? 413 : 502;
      const message = error instanceof LlmConfigError ? error.message : errorMessage(error);
      throw new InterviewCommandError(message, status);
    }

    let parsed: unknown;
    try { parsed = extractJson<unknown>(raw); }
    catch (error) {
      throw new InterviewCommandError(`AI 总评结果异常：${errorMessage(error)}`, 502);
    }
    const report = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? normalizeSeriesReport({ ...parsed, overall })
      : null;
    if (!report) {
      throw new InterviewCommandError("AI 总评缺少有效的综合结论、强项、短板或建议，请重试", 502);
    }

    signal.throwIfAborted();
    const ts = now();
    const predicates = reports.map(() => "EXISTS (SELECT 1 FROM interviews WHERE series_id = ? AND round_no = ? AND style = ? AND report = ?)").join(" AND ");
    const roundArgs = reports.flatMap((item) => [seriesId, item.round_no, item.style, item.raw]);
    const committed = inTransaction(() => db.prepare(`
      UPDATE interview_series SET status = 'finished', final_report = ?, finished_at = ?
      WHERE id = ? AND status = 'ongoing' AND final_report = ''
        AND (SELECT COUNT(*) FROM interviews WHERE series_id = ? AND report != '') = ?
        AND ${predicates}
    `).run(JSON.stringify(report), ts, seriesId, seriesId, SERIES_ROUNDS, ...roundArgs));
    if (committed.changes !== 1) throw new InterviewCommandError("进阶面试状态或三轮报告已变更，请刷新后重试", 409);
    return { report, finished_at: ts };
  } finally {
    release();
  }
}
