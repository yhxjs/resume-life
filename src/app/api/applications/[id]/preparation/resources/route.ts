import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { PreparationInputError, preparationApplication, parsePreparationKind, listPreparationResources, linkPreparationResource, unlinkPreparationResource } from "@/lib/application-preparation";
import { parsePaginationParams } from "@/lib/cursor-pagination";

async function handle(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = Number((await params).id);
    preparationApplication(id);
    if (req.method === "GET") {
      const query = new URL(req.url).searchParams;
      const kind = parsePreparationKind(query.get("kind"));
      const page = parsePaginationParams(query);
      if (!page.ok) return page.response;
      return NextResponse.json(listPreparationResources(id, kind, { candidates: query.get("candidates") === "true", limit: page.limit, cursor: page.idCursor }));
    }
    const parsed = await parseApiJson<{ kind?: unknown; id?: unknown } | null>(req);
    if (!parsed.ok) return parsed.response;
    const kind = parsePreparationKind(parsed.data?.kind);
    const resourceId = parsed.data?.id;
    if (typeof resourceId !== "number" || !Number.isSafeInteger(resourceId) || resourceId <= 0) throw new PreparationInputError("无效的资料 ID");
    if (req.method === "POST") linkPreparationResource(id, kind, resourceId);
    else unlinkPreparationResource(id, kind, resourceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof PreparationInputError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
export const GET = withRouteErrorHandling("GET /api/applications/[id]/preparation/resources", handle);
export const POST = withRouteErrorHandling("POST /api/applications/[id]/preparation/resources", handle);
export const DELETE = withRouteErrorHandling("DELETE /api/applications/[id]/preparation/resources", handle);
