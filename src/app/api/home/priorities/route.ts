import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { getHomePriorities } from "@/lib/home-priorities";

export const dynamic = "force-dynamic";

function handleGet(request: Request) {
  const timeZone = new URL(request.url).searchParams.get("time_zone") ?? undefined;
  if (timeZone !== undefined) {
    try { new Intl.DateTimeFormat("zh-CN", { timeZone }); }
    catch { return NextResponse.json({ error: "时区无效，请刷新后重试" }, { status: 400 }); }
  }
  return NextResponse.json(getHomePriorities(new Date(), timeZone));
}

export const GET = withRouteErrorHandling("GET /api/home/priorities", handleGet);
