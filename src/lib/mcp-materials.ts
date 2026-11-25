import { getDb, inTransaction } from "./db";
import { getApplicationById } from "./applications";
import { listPreparationResources, linkPreparationResource, unlinkPreparationResource } from "./application-preparation";
import type { PreparationKind } from "./application-preparation-types";
import { loadDiagnosis } from "./diagnosis-history";
import { loadIntroRecord } from "./intro-store";
import { loadJdPortrait } from "./jd-portrait-store";
import { mcpRevision } from "./mcp-revision";
import { fitPage, pageParams, type PageInput } from "./mcp-read";
import { McpOperationError } from "./mcp-errors";
import { boundMcpOutput } from "./mcp-output";

export const preparationRecordKinds = { diagnosis: "resume_diagnosis", portrait: "jd_portrait", intro: "intro",
  interview: "interview", series: "interview_series", notebook: "notebook" } as const;

function resourcesRevision(applicationId: number) {
  const application = getApplicationById(applicationId);
  if (!application) throw new McpOperationError("NOT_FOUND", "投递记录不存在");
  const links = getDb().prepare(`SELECT diagnosis_id,intro_id,portrait_id,interview_id,series_id,notebook_id
    FROM application_preparation_resources WHERE application_id=? ORDER BY id`).all(applicationId);
  return mcpRevision("preparation-resources", { application, links });
}

export function listMcpPreparationResources(input: PageInput & { applicationId: number; kind: PreparationKind; candidates?: boolean }) {
  const { limit, idCursor } = pageParams(input);
  const revision = resourcesRevision(input.applicationId);
  const result = listPreparationResources(input.applicationId, input.kind, { limit, cursor: idCursor, candidates: input.candidates });
  const page = fitPage(result.items.map(item => ({ ...item, fullContent: {
    tool: "read_record_section", kind: preparationRecordKinds[input.kind], id: item.id,
  } })), result.nextCursor, item => String(item.id));
  return { applicationId: input.applicationId, kind: input.kind, candidates: input.candidates ?? false, revision, total: result.total, ...page };
}

export function setMcpPreparationResource(input: { applicationId: number; kind: PreparationKind; resourceId: number; linked: boolean; expectedRevision: string }) {
  return inTransaction(() => {
    if (resourcesRevision(input.applicationId) !== input.expectedRevision) throw new McpOperationError("CONFLICT", "准备资料关联已更新，请重新读取资料列表");
    if (input.linked) linkPreparationResource(input.applicationId, input.kind, input.resourceId);
    else unlinkPreparationResource(input.applicationId, input.kind, input.resourceId);
    return { applicationId: input.applicationId, kind: input.kind, resourceId: input.resourceId, linked: input.linked };
  });
}

export function listMcpDiagnoses(input: PageInput & { resumeId: number; applicationId?: number }) {
  const { limit, idCursor } = pageParams(input);
  if (!getDb().prepare("SELECT 1 FROM resumes WHERE id=?").get(input.resumeId)) throw new McpOperationError("NOT_FOUND", "简历不存在");
  if (input.applicationId !== undefined) resourcesRevision(input.applicationId);
  const rows = getDb().prepare(`SELECT d.id,d.resume_id,d.resume_version_id,d.job_id,d.job_title,d.created_at,
    CASE WHEN json_valid(d.report) THEN json_extract(d.report,'$.match') END AS match
    FROM resume_diagnoses d WHERE d.resume_id=? AND (? IS NULL OR d.id < ?) AND
    (? IS NULL OR EXISTS (SELECT 1 FROM application_preparation_resources p WHERE p.application_id=? AND p.diagnosis_id=d.id))
    ORDER BY d.id DESC LIMIT ?`).all(input.resumeId, idCursor, idCursor, input.applicationId ?? null, input.applicationId ?? null, limit + 1) as
    { id: number; resume_id: number; resume_version_id: number | null; job_id: string; job_title: string; created_at: string; match: unknown }[];
  const items = rows.slice(0, limit).map(row => ({ ...row,
    match: typeof row.match === "number" && row.match >= 0 && row.match <= 10 ? row.match : null,
    fullContent: { tool: "read_record_section", kind: "resume_diagnosis", id: row.id } }));
  return fitPage(items, rows.length > limit ? String(items.at(-1)!.id) : null, item => String(item.id));
}

export function loadMcpPreparationMaterial(kind: "resume_diagnosis" | "jd_portrait" | "intro" | "interview_series", id: number): object | null {
  switch (kind) {
    case "jd_portrait": return loadJdPortrait(id, true);
    case "intro": return loadIntroRecord(id);
    case "resume_diagnosis": {
      const row = getDb().prepare("SELECT resume_id FROM resume_diagnoses WHERE id=?").get(id) as { resume_id: number } | undefined;
      return row ? loadDiagnosis(row.resume_id, id, true) : null;
    }
    case "interview_series": {
      const series = getDb().prepare("SELECT id,resume_id,resume_version_id,jd,rounds,status,final_report,created_at,finished_at FROM interview_series WHERE id=?")
        .get(id) as { id: number } | undefined;
      if (!series) return null;
      const rounds = getDb().prepare("SELECT id,series_id,round_no,status,style,created_at,finished_at FROM interviews WHERE series_id=? ORDER BY round_no,id").all(id);
      return { ...series, interviews: rounds };
    }
  }
}

export function getMcpPreparationMaterial(kind: Parameters<typeof loadMcpPreparationMaterial>[0], id: number) {
  const result = loadMcpPreparationMaterial(kind, id);
  if (!result) throw new McpOperationError("NOT_FOUND", "准备资料不存在或已删除");
  return { ...boundMcpOutput(result), fullContent: { tool: "read_record_section", kind, id } };
}
