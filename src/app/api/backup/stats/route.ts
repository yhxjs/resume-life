import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDatabaseStats } from "@/lib/backup";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

async function handleGet(request?: Request) {
  try {
    const stats = getDatabaseStats();
    return NextResponse.json({ ok: true, stats });
  } catch (err) {
    const requestId = logServerError("backup.stats", err, {
      requestId: requestIdFrom(request),
      status: 503,
    });
    return NextResponse.json(
      { ok: false, error: "获取数据统计失败，请检查数据库状态后重试", requestId },
      { status: 503 }
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/backup/stats", handleGet);
