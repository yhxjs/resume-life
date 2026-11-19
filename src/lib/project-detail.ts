import { inTransaction } from "./db";
import { loadProjectRow } from "./projects";
import { listProjectMaterials } from "./project-materials";
import { projectSummaryRevision } from "./project-summary-history";
import { parseSummary } from "./summary";

/** 页面正文、材料页与编辑版本必须来自同一快照；解析和响应序列化在事务外。 */
export function loadProjectDetail(projectId: number, cursor: number | null, limit: number) {
  const snapshot = inTransaction(() => {
    const project = loadProjectRow(projectId);
    return project ? {
      project,
      materials: listProjectMaterials(projectId, cursor, limit),
      revisionId: projectSummaryRevision(projectId),
    } : null;
  });
  if (!snapshot) return null;
  const { project, materials, revisionId } = snapshot;
  return {
    id: project.id,
    name: project.name,
    summary: parseSummary(project.summary),
    summary_updated_at: project.summary_updated_at,
    summary_revision_id: revisionId,
    // 合法空值不代表损坏；损坏结构由调用方返回422。
    summary_corrupt: false,
    updated_at: project.updated_at,
    materials: materials.items,
    materials_next_cursor: materials.nextCursor,
    materials_total: materials.total,
  };
}
