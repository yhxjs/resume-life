import { createHash } from "node:crypto";
import { getDb, inTransaction, now, withReadSnapshot } from "./db";
import { createCursorPage, type CursorPage } from "./cursor-pagination";
import { loadProjectRow } from "./projects";
import { adoptSummaryChanges, compareProjectSummaries, type SummaryAiBaseline, type SummaryChange, type SummaryUnitKey } from "./project-summary-diff";
import { normalizeSummary, parseSummary, ProjectSummaryCorruptError, SUMMARY_SECTIONS, type ProjectSummary } from "./summary";
import { assertBackupRecordBytes, BackupLimitError } from "./backup-limits";
import { isStoredProjectMaterialSnapshot, isStoredSummaryAiBaseline } from "./backup-domain";
import { serializeProjectSummaryMaterial } from "./project-summary-llm";
import { iterateProjectMaterialSources, type ProjectMaterialSource } from "./project-materials";
import { serializeDocumentTableProvenance } from "./document-table-provenance";

export type MaterialSnapshotItem = { id: number; title: string; digest: string };
export type MaterialChange = { id: number; title: string; status: "new" | "changed" | "removed" };
export type ProjectSummaryHistoryItem = {
  id: number;
  source: "ai" | "repo" | "manual";
  createdAt: string;
  summary: ProjectSummary;
  aiBaseline: SummaryAiBaseline;
};

type HistoryRow = { id: number; source: ProjectSummaryHistoryItem["source"]; created_at: string; summary: string; ai_baseline: string; material_snapshot: string | null };
const STRING_UNIT_KEYS = [...SUMMARY_SECTIONS.map(({ key }) => key), "techStack", "brief"] as const;

export class ProjectSummaryHistoryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProjectSummaryHistoryError";
  }
}

function latestHistory(projectId: number, db = getDb()): HistoryRow | undefined {
  return db.prepare("SELECT id, source, created_at, summary, ai_baseline, material_snapshot FROM project_summary_history WHERE project_id = ? ORDER BY id DESC LIMIT 1")
    .get(projectId) as HistoryRow | undefined;
}

function corruptHistory(row: HistoryRow): ProjectSummaryHistoryError {
  return new ProjectSummaryHistoryError(`项目总结历史（版本 ${row.id}）已损坏，请修复历史数据或从有效备份恢复后重试`, 422);
}

function parseHistoryJson(row: HistoryRow, raw: string, valid: (value: unknown) => boolean): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw corruptHistory(row); }
  if (!valid(value)) throw corruptHistory(row);
  return value;
}

function historyBaseline(row: HistoryRow): SummaryAiBaseline {
  return parseHistoryJson(row, row.ai_baseline, isStoredSummaryAiBaseline) as SummaryAiBaseline;
}

/** 只验证本次要消费或继承的元数据，不改写历史原文。 */
function historyMetadata(row: HistoryRow | undefined) {
  return {
    baseline: row ? historyBaseline(row) : {},
    materials: !row || row.material_snapshot === null ? null
      : parseHistoryJson(row, row.material_snapshot, isStoredProjectMaterialSnapshot) as MaterialSnapshotItem[],
  };
}

function historySummary(row: HistoryRow): ProjectSummary {
  try { return parseSummary(row.summary); }
  catch (error) {
    if (error instanceof ProjectSummaryCorruptError) throw corruptHistory(row);
    throw error;
  }
}

function snapshotItem({ id, title, content, tableProvenance }: ProjectMaterialSource): MaterialSnapshotItem {
  const digest = createHash("sha256").update(title).update("\0").update(content);
  if (tableProvenance !== undefined) digest.update("\0docx-table-provenance-v1\0").update(serializeDocumentTableProvenance(tableProvenance, content));
  return { id, title, digest: digest.digest("hex") };
}

export function captureProjectMaterialSnapshot(projectId: number, db = getDb()): MaterialSnapshotItem[] {
  return Array.from(iterateProjectMaterialSources(projectId, db), snapshotItem);
}

/** 草稿携带的指纹同时绑定项目身份和生成时名称；持久化材料快照格式保持不变。 */
function materialFingerprint(projectId: number, projectName: string, snapshot: MaterialSnapshotItem[]): string {
  return createHash("sha256").update(JSON.stringify({ projectId, projectName, materials: snapshot })).digest("hex");
}

function compareMaterials(previous: MaterialSnapshotItem[] | null, current: MaterialSnapshotItem[]): MaterialChange[] {
  if (previous === null) return [];
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(current.map((item) => [item.id, item]));
  const changes: MaterialChange[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)) {
    const oldItem = before.get(id);
    const newItem = after.get(id);
    if (!oldItem && newItem) changes.push({ id, title: newItem.title, status: "new" });
    else if (oldItem && !newItem) changes.push({ id, title: oldItem.title, status: "removed" });
    else if (oldItem && newItem && oldItem.digest !== newItem.digest) changes.push({ id, title: newItem.title, status: "changed" });
  }
  return changes;
}

function alignAchievementBaseline(previous: ProjectSummary, saved: ProjectSummary, baseline: SummaryAiBaseline): SummaryAiBaseline {
  const aligned = Object.fromEntries(Object.entries(baseline).filter(([key]) => !key.startsWith("achievement:")));
  const used = new Set<number>();
  const matches = new Map<number, number>();
  saved.achievements.forEach((text, nextIndex) => {
    const oldIndex = previous.achievements.findIndex((value, index) => value === text && !used.has(index));
    if (oldIndex < 0) return;
    used.add(oldIndex);
    matches.set(nextIndex, oldIndex);
  });
  if (previous.achievements.length === saved.achievements.length) {
    const unmatchedOld = previous.achievements.map((_, index) => index).filter((index) => !used.has(index));
    const unmatchedNew = saved.achievements.map((_, index) => index).filter((index) => !matches.has(index));
    unmatchedNew.forEach((index, position) => matches.set(index, unmatchedOld[position]!));
  }
  for (const [nextIndex, oldIndex] of matches) {
    const origin = baseline[`achievement:${oldIndex}`];
    if (origin !== undefined) aligned[`achievement:${nextIndex}`] = origin;
  }
  return aligned;
}

export function projectSummaryRevision(projectId: number): number {
  return latestHistory(projectId)?.id ?? 0;
}

function readSummaryHeader(projectId: number, db: ReturnType<typeof getDb>) {
  const project = loadProjectRow(projectId, db);
  if (!project) throw new ProjectSummaryHistoryError("项目不存在", 404);
  const latest = latestHistory(projectId, db);
  historyMetadata(latest);
  return { project, revisionId: latest?.id ?? 0 };
}

export function captureProjectSummarySource(projectId: number) {
  return withReadSnapshot(db => ({
    ...readSummaryHeader(projectId, db),
    materials: captureProjectMaterialSnapshot(projectId, db),
  }));
}

/** 模型正文与指纹都来自同一行，只为预算内的完整记录计算摘要。 */
export function captureProjectSummaryInput(projectId: number, maxMaterialChars: number) {
  return withReadSnapshot(db => {
    const header = readSummaryHeader(projectId, db);
    const materials: MaterialSnapshotItem[] = [];
    const chunks: string[] = [];
    let remaining = maxMaterialChars;
    for (const material of iterateProjectMaterialSources(projectId, db)) {
      if (material.title.length + material.content.length > remaining) throw new ProjectSummaryHistoryError(
        `项目材料超过单次总结的 ${maxMaterialChars} 字符限制（含标题与材料结构），请精简材料后重试；本次未生成总结，原材料保持不变`, 413,
      );
      const text = serializeProjectSummaryMaterial(material, materials.length);
      if (text.length > remaining) throw new ProjectSummaryHistoryError(
        `项目材料超过单次总结的 ${maxMaterialChars} 字符限制（含标题与材料结构），请精简材料后重试；本次未生成总结，原材料保持不变`, 413,
      );
      remaining -= text.length;
      chunks.push(text);
      materials.push(snapshotItem(material));
    }
    return { ...header, materials, materialText: chunks.join("") };
  });
}

export function prepareProjectSummaryProposal(projectId: number, generated: ProjectSummary, sourceMaterials = captureProjectMaterialSnapshot(projectId), sourceRevisionId = projectSummaryRevision(projectId), sourceProjectName?: string): {
  summary: ProjectSummary;
  comparison: SummaryChange[];
  materialChanges: MaterialChange[];
  materialFingerprint: string;
  revisionId: number;
} {
  const project = loadProjectRow(projectId);
  if (!project) throw new ProjectSummaryHistoryError("项目不存在", 404);
  const latest = latestHistory(projectId);
  const current = parseSummary(project.summary);
  const { baseline, materials: previousMaterials } = historyMetadata(latest);
  return {
    summary: generated,
    comparison: compareProjectSummaries(current, generated, baseline),
    materialChanges: previousMaterials === null ? [] : compareMaterials(previousMaterials, sourceMaterials),
    materialFingerprint: materialFingerprint(projectId, sourceProjectName ?? project.name, sourceMaterials),
    revisionId: sourceRevisionId,
  };
}

export function saveProjectSummary(projectId: number, input: {
  summary: ProjectSummary;
  expectedRevisionId?: number;
  proposal?: { generated: ProjectSummary; acceptedKeys: SummaryUnitKey[]; source: "ai" | "repo"; materialFingerprint: string };
}): ProjectSummaryHistoryItem {
  return inTransaction(() => {
    const project = loadProjectRow(projectId);
    if (!project) throw new ProjectSummaryHistoryError("项目不存在", 404);
    const latest = latestHistory(projectId);
    if (input.expectedRevisionId !== undefined && input.expectedRevisionId !== (latest?.id ?? 0)) {
      throw new ProjectSummaryHistoryError("项目总结已更新，请刷新后重新核对草稿", 409);
    }
    const currentMaterials = captureProjectMaterialSnapshot(projectId);
    if (input.proposal && input.proposal.materialFingerprint !== materialFingerprint(projectId, project.name, currentMaterials)) {
      throw new ProjectSummaryHistoryError("草稿对应的项目、名称或材料已更新，请重新生成并核对草稿", 409);
    }
    const current = parseSummary(project.summary);
    const { baseline: previousBaseline } = historyMetadata(latest);
    const summary = normalizeSummary(input.summary);
    const adopted = input.proposal
      ? adoptSummaryChanges(current, input.proposal.generated, previousBaseline, input.proposal.acceptedKeys)
      : { summary: current, aiBaseline: previousBaseline };
    let aiBaseline = alignAchievementBaseline(adopted.summary, summary, adopted.aiBaseline);
    if (input.proposal && !latest) {
      const origin: SummaryAiBaseline = {};
      for (const key of STRING_UNIT_KEYS) {
        if (summary[key] && input.proposal.generated[key]) origin[key] = input.proposal.generated[key];
      }
      input.proposal.generated.achievements.forEach((text, index) => { origin[`achievement:${index}`] = text; });
      aiBaseline = alignAchievementBaseline(input.proposal.generated, summary, origin);
    }
    if (input.proposal) {
      const generated = input.proposal.generated;
      for (const key of STRING_UNIT_KEYS) {
        if (summary[key] && summary[key] === generated[key]) aiBaseline[key] = summary[key];
      }
      summary.achievements.forEach((text, index) => {
        if (generated.achievements.includes(text)) aiBaseline[`achievement:${index}`] = text;
      });
    }
    const source = input.proposal?.source ?? "manual";
    const timestamp = now();
    const generated = input.proposal?.generated;
    const includesNewAiText = generated && (
      STRING_UNIT_KEYS.some((key) => Boolean(summary[key]) && summary[key] === generated[key] && summary[key] !== current[key]) ||
      summary.achievements.some((text, index) => text !== current.achievements[index] && generated.achievements.includes(text))
    );
    const snapshot = input.proposal && (input.proposal.acceptedKeys.length > 0 || !latest || includesNewAiText)
      ? JSON.stringify(currentMaterials)
      : latest?.material_snapshot ?? null;
    const saved = getDb().prepare("INSERT INTO project_summary_history (project_id, summary, ai_baseline, material_snapshot, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(projectId, JSON.stringify(summary), JSON.stringify(aiBaseline), snapshot, source, timestamp);
    const row = getDb().prepare("SELECT * FROM project_summary_history WHERE id = ?").get(saved.lastInsertRowid);
    // 检查最终备份行（包括 JSON 二次转义和 AI 基线）；超限由当前事务一起回滚。
    try {
      assertBackupRecordBytes(Buffer.byteLength(`${JSON.stringify({ kind: "row", table: "project_summary_history", data: row })}\n`, "utf8"));
    } catch (error) {
      if (error instanceof BackupLimitError) throw new ProjectSummaryHistoryError("项目总结历史内容过大，请精简总结或材料标题后重试", 413);
      throw error;
    }
    getDb().prepare("UPDATE projects SET summary = ?, summary_updated_at = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(summary), timestamp, timestamp, projectId);
    return { id: Number(saved.lastInsertRowid), source, createdAt: timestamp, summary, aiBaseline };
  });
}

export function listProjectSummaryHistory(projectId: number, cursor: number | null, limit: number): CursorPage<ProjectSummaryHistoryItem> {
  const rows = getDb().prepare("SELECT id, source, created_at, summary, ai_baseline, material_snapshot FROM project_summary_history WHERE project_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")
    .all(projectId, cursor, cursor, limit + 1) as HistoryRow[];
  const page = createCursorPage(rows, limit, (row) => String(row.id));
  return { ...page, items: page.items.map((row) => ({
    id: row.id,
    source: row.source,
    createdAt: row.created_at,
    summary: historySummary(row),
    aiBaseline: historyBaseline(row),
  })) };
}
