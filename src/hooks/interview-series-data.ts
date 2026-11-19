import { normalizeReport } from "@/lib/scores";
import { normalizeSeriesReport, SERIES_ROUNDS } from "@/lib/series";
import type { SeriesData } from "./interview-series-types";

/** 读取恢复必须确认实体、轮次和报告形状，不能将字段缺失误认成尚未保存。 */
export function readSeriesData(raw: SeriesData, id: number): SeriesData {
  if (!raw || raw.id !== id || !Array.isArray(raw.entries) || raw.rounds_total !== SERIES_ROUNDS ||
      !["ongoing", "finished"].includes(raw.status) || typeof raw.finished_at !== "string" ||
      typeof raw.resume_title !== "string" || typeof raw.jd !== "string") {
    throw new Error("服务器返回的系列状态不完整");
  }
  const finalReport = raw.final_report === null ? null : normalizeSeriesReport(raw.final_report);
  if (raw.final_report !== null && !finalReport) throw new Error("服务器返回的跨轮总评无法读取");
  const seenIds = new Set<number>();
  const entries = raw.entries.map((entry) => {
    if (!entry || !Number.isSafeInteger(entry.interview_id) || entry.interview_id <= 0 || seenIds.has(entry.interview_id) ||
        !Number.isSafeInteger(entry.round_no) || entry.round_no < 1 || entry.round_no > SERIES_ROUNDS ||
        !["ongoing", "finished"].includes(entry.status)) throw new Error("服务器返回的系列轮次不完整");
    seenIds.add(entry.interview_id);
    const report = entry.report === null ? null : normalizeReport(entry.report);
    if (entry.report !== null && !report) throw new Error("服务器返回的单轮报告无法读取");
    return { ...entry, report };
  }).sort((a, b) => a.round_no - b.round_no);
  if (entries.some((entry, index) => entry.round_no !== index + 1)) throw new Error("服务器返回的系列轮次不连续或重复");
  return { ...raw, final_report: finalReport, entries };
}
