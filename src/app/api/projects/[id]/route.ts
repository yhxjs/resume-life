import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { loadProjectRow } from "@/lib/projects";
import { parseSummary, normalizeSummary, ProjectSummaryCorruptError, SUMMARY_SECTIONS, isGeneratedProjectSummary, isStoredProjectSummary } from "@/lib/summary";
import { projectSummaryRevision, saveProjectSummary, ProjectSummaryHistoryError } from "@/lib/project-summary-history";
import type { SummaryUnitKey } from "@/lib/project-summary-diff";
import { parsePaginationParams } from "@/lib/cursor-pagination";
import { listProjectMaterials } from "@/lib/project-materials";

function isSummaryUnitKey(value: unknown): value is SummaryUnitKey {
  return typeof value === "string" && (
    ["overview", "architecture", "highlights", "responsibilities", "challenges", "techStack", "brief"].includes(value) ||
    /^achievement:(0|[1-9]\d*)$/.test(value)
  );
}

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const row = loadProjectRow(numericId);
  if (!row) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const url = new URL(_req.url);
  const pagination = parsePaginationParams(url.searchParams, "id");
  if (!pagination.ok) return pagination.response;
  const { limit, idCursor } = pagination;
  const materialsPage = listProjectMaterials(numericId, idCursor, limit);
  let summary;
  try {
    summary = parseSummary(row.summary);
  } catch (err) {
    if (err instanceof ProjectSummaryCorruptError) return NextResponse.json({ error: err.message }, { status: 422 });
    throw err;
  }
  // 有更新时间但五个字段全空，说明存储的总结 JSON 已损坏（与"未生成过总结"区分开）
  const summaryCorrupt =
    row.summary_updated_at !== "" && SUMMARY_SECTIONS.every((s) => !summary[s.key].trim());
  return NextResponse.json({
    id: row.id,
    name: row.name,
    summary,
    summary_updated_at: row.summary_updated_at,
    summary_revision_id: projectSummaryRevision(numericId),
    summary_corrupt: summaryCorrupt,
    updated_at: row.updated_at,
    materials: materialsPage.items,
    materials_next_cursor: materialsPage.nextCursor,
    materials_total: materialsPage.total,
  });
}

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  }
  const o = body as Record<string, unknown>;
  const db = getDb();
  const exists = db.prepare("SELECT id FROM projects WHERE id = ?").get(numericId);
  if (!exists) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  let revisionId: number | undefined;
  let summaryToSave: ReturnType<typeof normalizeSummary> | undefined;
  let expectedRevisionId: number | undefined;
  let proposalToSave: { generated: ReturnType<typeof normalizeSummary>; acceptedKeys: SummaryUnitKey[]; source: "ai" | "repo"; materialFingerprint: string } | undefined;
  if (o.summary !== undefined) {
    if (!isStoredProjectSummary(o.summary)) {
      return NextResponse.json({ error: "总结字段无效" }, { status: 400 });
    }
    if (o.expectedRevisionId !== undefined && (!Number.isSafeInteger(o.expectedRevisionId) || (o.expectedRevisionId as number) < 0)) {
      return NextResponse.json({ error: "总结版本参数无效" }, { status: 400 });
    }
    let proposal: typeof proposalToSave;
    if (o.proposal !== undefined) {
      if (!o.proposal || typeof o.proposal !== "object" || Array.isArray(o.proposal)) {
        return NextResponse.json({ error: "总结草稿参数无效" }, { status: 400 });
      }
      const value = o.proposal as Record<string, unknown>;
      if (!isGeneratedProjectSummary(value.generated) || !Array.isArray(value.acceptedKeys) ||
          !value.acceptedKeys.every(isSummaryUnitKey) || (value.source !== "ai" && value.source !== "repo") ||
          typeof value.materialFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.materialFingerprint)) {
        return NextResponse.json({ error: "总结草稿参数无效" }, { status: 400 });
      }
      proposal = { generated: normalizeSummary(value.generated), acceptedKeys: value.acceptedKeys as SummaryUnitKey[], source: value.source, materialFingerprint: value.materialFingerprint };
    }
    summaryToSave = normalizeSummary(o.summary);
    expectedRevisionId = o.expectedRevisionId as number | undefined;
    proposalToSave = proposal;
  }
  try {
    inTransaction(() => {
      if (summaryToSave) {
        revisionId = saveProjectSummary(numericId, { summary: summaryToSave, expectedRevisionId, proposal: proposalToSave }).id;
      }
      if (typeof o.name === "string" && o.name.trim()) {
        db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(o.name.trim(), now(), numericId);
      }
    });
  } catch (error) {
    if (error instanceof ProjectSummaryHistoryError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return NextResponse.json({ ok: true, revisionId });
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => {
    clearEntityLlmLabels(db, "project", numericId);
    return db.prepare("DELETE FROM projects WHERE id = ?").run(numericId);
  });
  if (result.changes === 0) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PATCH = withRouteErrorHandling("PATCH /api/projects/[id]", handlePatch);
export const DELETE = withRouteErrorHandling("DELETE /api/projects/[id]", handleDelete);
export const GET = withRouteErrorHandling("GET /api/projects/[id]", handleGet);
