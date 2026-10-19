import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getApplicationStats } from "@/lib/applications";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

async function handleGet(request?: Request) {
  try {
    const stats = getApplicationStats();
    return NextResponse.json(stats);
  } catch (err) {
    const requestId = logServerError("applications.stats", err, { requestId: requestIdFrom(request), status: 500 });
    return NextResponse.json(
      { error: "读取投递统计失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/applications/stats", handleGet);
