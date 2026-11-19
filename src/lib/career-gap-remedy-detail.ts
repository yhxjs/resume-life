import { parseRemedyResult, type ResignationGapRemedyResult } from "./career-gap-remedy";

export type CareerGapRemedyDetail = {
  id: number;
  scenario_type: string;
  raw_story: string;
  target_role: string;
  persona_style: string;
  result: ResignationGapRemedyResult | null;
  created_at: string;
};

/** 详情与删除核对共用历史协议；不截断旧原稿、不补造缺失报告。 */
export function readCareerGapRemedyDetail(value: unknown, expectedId: number): CareerGapRemedyDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("报告响应不完整或记录不符，请重新读取");
  const data = value as CareerGapRemedyDetail;
  if (!Number.isSafeInteger(data.id) || data.id <= 0 || data.id !== expectedId ||
    !["raw_story", "scenario_type", "target_role", "persona_style", "created_at"].every(key => typeof (value as Record<string, unknown>)[key] === "string") ||
    (data.result !== null && !parseRemedyResult(JSON.stringify(data.result)))) {
    throw new Error("报告响应不完整或记录不符，请重新读取");
  }
  return data;
}
