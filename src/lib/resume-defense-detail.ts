import type { DefenseDrillRecord, ResumeDefenseReport } from "./resume-defense";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDefenseDrill(value: unknown, defenseId: number, itemId: string): value is DefenseDrillRecord {
  return positiveId(defenseId) && !!itemId.trim() && record(value) && positiveId(value.id) && value.defenseId === defenseId && value.itemId === itemId &&
    ["question", "userAnswer", "interviewerRoast", "defenseCritique", "improvedAnswer", "createdAt", "updatedAt"].every((key) => typeof value[key] === "string") &&
    typeof value.defenseScore === "number" && Number.isFinite(value.defenseScore);
}

/** 新提交的完成响应还须与提交快照相符，不能拿其他问题、原答或条目的评估冒充。 */
export function readDefenseDrill(value: unknown, defenseId: number, itemId: string, submission: { question: string; userAnswer: string }): DefenseDrillRecord {
  if (!isDefenseDrill(value, defenseId, itemId) || value.question !== submission.question || value.userAnswer !== submission.userAnswer ||
    value.defenseScore < 0 || value.defenseScore > 100 ||
    ![value.interviewerRoast, value.defenseCritique, value.improvedAnswer, value.createdAt, value.updatedAt].every((text) => text.trim())) {
    throw new Error("演练评估响应不完整或记录不符，请先重新读取存档");
  }
  return value;
}

/** 只校验历史展示协议与记录归属，不套用新生成的数量、文本长度或引用匹配规则。 */
export function readDefenseDetail(value: unknown, id: string): { report: ResumeDefenseReport; drills: DefenseDrillRecord[] } {
  const fail = (): never => { throw new Error("排雷报告响应不完整或记录不符，请重新读取"); };
  if (!record(value) || !record(value.report) || !Array.isArray(value.drills)) return fail();
  const report = value.report;
  if (!positiveId(report.id) || report.id !== Number(id) ||
    (report.resumeId !== undefined && report.resumeId !== null && !positiveId(report.resumeId)) ||
    (report.resumeVersionId !== undefined && report.resumeVersionId !== null && !positiveId(report.resumeVersionId)) ||
    !["title", "sourceContent", "targetRole", "overallRoast", "createdAt"].every((key) => typeof report[key] === "string") ||
    (report.riskLevel !== undefined && report.riskLevel !== null && typeof report.riskLevel !== "string") ||
    !Array.isArray(report.items)) return fail();
  const itemIds = new Set<string>();
  for (const item of report.items) {
    if (!record(item) || typeof item.id !== "string" || !item.id.trim() || itemIds.has(item.id) ||
      !["originalText", "sectionHint", "interviewerRoast"].every((key) => typeof item[key] === "string") ||
      (item.riskLevel !== undefined && item.riskLevel !== null && typeof item.riskLevel !== "string") ||
      (item.riskType !== undefined && item.riskType !== null && typeof item.riskType !== "string") ||
      !texts(item.deadlyQuestions) || !record(item.defensePlan) ||
      typeof item.defensePlan.interviewerIntent !== "string" || typeof item.defensePlan.standardDefense !== "string" ||
      !texts(item.defensePlan.tabooMistakes)) return fail();
    itemIds.add(item.id);
  }
  const drillIds = new Set<number>();
  const drilledItems = new Set<string>();
  for (const drill of value.drills) {
    if (!record(drill) || !positiveId(drill.id) || drillIds.has(drill.id) ||
      typeof drill.itemId !== "string" || !itemIds.has(drill.itemId) || drilledItems.has(drill.itemId) ||
      !isDefenseDrill(drill, report.id, drill.itemId)) return fail();
    drillIds.add(drill.id); drilledItems.add(drill.itemId);
  }
  return value as { report: ResumeDefenseReport; drills: DefenseDrillRecord[] };
}
