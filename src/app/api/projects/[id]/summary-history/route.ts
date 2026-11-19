import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parsePaginationParams } from "@/lib/cursor-pagination";
import { listProjectSummaryHistory, ProjectSummaryHistoryError } from "@/lib/project-summary-history";
import { loadProjectRow } from "@/lib/projects";

async function handleGet(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  if (!loadProjectRow(id)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  const pagination = parsePaginationParams(new URL(request.url).searchParams);
  if (!pagination.ok) return pagination.response;
  try {
    return NextResponse.json({ projectId: id, ...listProjectSummaryHistory(id, pagination.idCursor, pagination.limit) });
  } catch (error) {
    if (error instanceof ProjectSummaryHistoryError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/projects/[id]/summary-history", handleGet);
