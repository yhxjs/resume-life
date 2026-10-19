import { parseApiJson, type ApiJsonResult } from "./api-request";
import { isAnonymizeConfig, type AnonymizeConfig } from "./resume-anonymize";

export type ResumeExportOptions = {
  anonymizeConfig?: AnonymizeConfig;
  confirmedIssueIds?: unknown;
  skipExportCheck?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


/** 配置一旦传入就必须完整有效，不能因解析或校验失败退回未脱敏导出。 */
export async function parseResumeExportRequest(request: Request): Promise<ApiJsonResult<ResumeExportOptions>> {
  const parsed = await parseApiJson<unknown>(request);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.data)) {
    return { ok: false, response: Response.json({ error: "导出请求格式无效" }, { status: 400 }) };
  }
  const { anonymizeConfig, confirmedIssueIds, skipExportCheck } = parsed.data;
  if (anonymizeConfig !== undefined && !isAnonymizeConfig(anonymizeConfig)) {
    return { ok: false, response: Response.json({ error: "脱敏配置格式无效" }, { status: 400 }) };
  }
  return { ok: true, data: { anonymizeConfig, confirmedIssueIds, skipExportCheck } };
}
