import { isInterviewEvaluatorReport, isInterviewReport, isInterviewReverseResult } from "@/lib/interview-detail";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown) => typeof value === "string" && Boolean(value.trim());
const belongsTo = (value: unknown, expectedId: number) => Number.isSafeInteger(expectedId) && expectedId > 0 && value === expectedId;

/** 只确认回执；页面数据仍由完整详情 GET 核对，不用 POST 内容覆盖当前页面。 */
export function assertInterviewReportReceipt(value: unknown, interviewId: number, mining: boolean): void {
  if (!record(value) || !belongsTo(value.interview_id, interviewId) || !isInterviewReport(value.report) ||
      !nonempty(value.finished_at) || !(value.evaluator_report === null || isInterviewEvaluatorReport(value.evaluator_report)) ||
      (mining && (!record(value.report) || !record(value.report.mining_summary)))) {
    throw new Error("服务器返回的报告保存回执不完整或与当前面试不符");
  }
}

export function assertInterviewReverseReceipt(value: unknown, interviewId: number, question: string): void {
  const invalid = () => new Error("服务器返回的反问保存回执不完整或与本次提问不符");
  if (!record(value) || value.ok !== true || !belongsTo(value.interview_id, interviewId) || !isInterviewReverseResult(value.reverse) ||
      !record(value.reverse) || value.reverse.question !== question || !nonempty(value.reverse.answer) || !nonempty(value.reverse.created_at)) throw invalid();
  const evaluation = value.reverse.evaluation;
  if (!record(evaluation) || !["level", "insight", "feedback", "suggestions"].every(key => nonempty(evaluation[key]))) throw invalid();
}
