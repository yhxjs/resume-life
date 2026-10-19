import { NextResponse } from "next/server";
import type { ModuleData } from "@/lib/modules";
import { inspectResumeForExport } from "@/lib/resume-export-check";
import type { ResumeWithModules } from "@/lib/resumes";

/** 数据损坏不可跳过；数字与占位符核对仅在本次请求显式选择时放行。 */
export function guardResumeExport(title: string, modules: ModuleData[], confirmedIssueIds?: unknown, skipExportCheck?: unknown, integrity?: Pick<ResumeWithModules, "resume" | "corruptedKeys">) {
  if (integrity?.resume.styleCorrupted) return NextResponse.json({
    error: "导出已暂停：排版数据损坏，请修复并保存排版后重新导出。",
  }, { status: 422 });
  const corruptedKeys = integrity?.corruptedKeys ?? [];
  if (corruptedKeys.length > 0) return NextResponse.json({
    error: "导出已暂停：部分模块数据损坏，请修复后重新导出。",
    corruptedKeys,
  }, { status: 422 });
  if (skipExportCheck === true) return null;
  const confirmed = Array.isArray(confirmedIssueIds) ? confirmedIssueIds.filter((id): id is string => typeof id === "string") : [];
  const check = inspectResumeForExport({ title, modules, confirmedIssueIds: new Set(confirmed) });
  return check.canExport ? null : NextResponse.json({
    error: "导出已暂停：存在未确认数字或残留占位符，请回到简历重新检查并定位修改。",
    issues: check.blockingIssues,
  }, { status: 409 });
}
