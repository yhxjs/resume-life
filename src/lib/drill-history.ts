export type DrillItem = {
  id: number;
  source: string;
  direction: string;
  jd: string;
  focus: string;
  created_at: string;
  project_name: string | null;
  total: number;
  answered: number;
};

/** 删除确认使用完整来源说明；卡片标题的截断不适用于危险操作。 */
export function drillDeletionTitle(drill: DrillItem): string {
  const source = drill.source === "project" ? `项目：${drill.project_name ?? "未命名项目"}`
    : drill.source === "interview" ? "面试追练" : "通用题库";
  return `${source}；方向：${drill.direction || "未指定"}；JD：${drill.jd || "未提供"}；重点：${drill.focus || "未指定"}；创建时间：${drill.created_at}；已答 ${drill.answered}/${drill.total} 题`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** 只读核对同一存档，不按新生成题目的篇幅或题型限制重写历史。 */
export function validateExistingDrill(value: unknown, id: number): void {
  if (record(value) && positiveId(value.id) && value.id === id &&
    ["source", "direction", "jd", "focus", "created_at"].every(key => typeof value[key] === "string") &&
    (value.project_name === null || typeof value.project_name === "string") &&
    (value.project_id === null || positiveId(value.project_id)) &&
    (value.interview_id === null || positiveId(value.interview_id)) &&
    Array.isArray(value.questions) && value.questions.every(question => record(question) && positiveId(question.id) &&
      Number.isSafeInteger(question.idx) && (question.idx as number) >= 0 &&
      ["question", "answer", "comment", "reference", "kind", "answered_at"].every(key => typeof question[key] === "string"))) return;
  throw new Error("读取响应不完整或记录不符");
}
