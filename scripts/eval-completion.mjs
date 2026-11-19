import { readFileSync } from "node:fs";
import path from "node:path";
import { hasExactEvaluationSampleIds } from "./eval-selection.mjs";

/**
 * 子进程可能因整套跳过而成功退出；仅本轮完整汇总可确认评测完成。
 * @param {number | null} code
 * @param {{ output: string; suite: string; live: boolean; requestedIds?: readonly string[] }} options
 * @returns {number}
 */
export function evaluationExitCode(code, { output, suite, live, requestedIds = [] }) {
  if (code !== 0) return code ?? 1;
  try {
    const summary = JSON.parse(readFileSync(path.join(output, "summary.json"), "utf8"));
    const selectionMatches = requestedIds.length
      ? summary?.selection && Number.isSafeInteger(summary.selection.suiteSamples) &&
        summary.selection.suiteSamples >= requestedIds.length &&
        Array.isArray(summary.selection.requestedIds) &&
        summary.selection.requestedIds.length === requestedIds.length &&
        requestedIds.every((id, index) => summary.selection.requestedIds[index] === id) &&
        summary.expectedSamples === requestedIds.length &&
        hasExactEvaluationSampleIds(requestedIds, summary.results?.map(result => result?.id))
      : summary?.selection === undefined;
    if (summary?.status === "completed" && summary.suite === suite && summary.mode === (live ? "live" : "snapshot") &&
        Number.isSafeInteger(summary.expectedSamples) && summary.expectedSamples > 0 &&
        summary.recordedSamples === summary.expectedSamples && summary.missingSamples === 0 &&
        Array.isArray(summary.results) && summary.results.length === summary.expectedSamples && selectionMatches) return 0;
  } catch {
    // 不复制文件内容或底层错误，已有产物留在本轮目录供核对。
  }
  console.error("评估未生成与本轮套件和模式一致的完整汇总，请检查输出目录。");
  return 1;
}
