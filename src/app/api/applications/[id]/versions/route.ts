import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { getApplicationVersions } from "@/lib/applications";

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return NextResponse.json({ error: "无效的投递 ID" }, { status: 400 });
  }
  const versions = getApplicationVersions(id);
  if (!versions) return NextResponse.json({ error: "投递记录不存在" }, { status: 404 });
  return NextResponse.json(versions, { headers: { "Cache-Control": "no-store" } });
}

export const GET = withRouteErrorHandling("GET /api/applications/[id]/versions", handleGet);
