import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { loadNotebookFavorite } from "@/lib/notebook-storage";

export const GET = withRouteErrorHandling("GET /api/notebook/lookup", async req => {
  const params = new URL(req.url).searchParams;
  const source = params.get("source"); const sourceId = parseCanonicalPositiveId(params.get("source_id"));
  if ((source !== "drill" && source !== "interview") || !Number.isSafeInteger(sourceId) || sourceId <= 0) {
    return NextResponse.json({ error: "无效的收藏来源" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const saved = loadNotebookFavorite(source, sourceId);
  return saved ? NextResponse.json(saved, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "该来源当前未收藏" }, { status: 404, headers: { "Cache-Control": "no-store" } });
});
