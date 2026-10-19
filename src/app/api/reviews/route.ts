import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parsePaginationParams } from "@/lib/cursor-pagination";
import { listReviewCards } from "@/lib/spaced-repetition-cards";
import { getReviewDate } from "@/lib/spaced-repetition";

export const dynamic = "force-dynamic";

function handleGet(req: Request) {
  const params = new URL(req.url).searchParams;
  const scope = params.get("scope") ?? "due";
  const source = params.get("source") ?? "all";
  if ((scope !== "due" && scope !== "all") || (source !== "all" && source !== "notebook" && source !== "remedial")) {
    return NextResponse.json({ error: "复习筛选参数无效" }, { status: 400 });
  }
  try {
    const today = getReviewDate(new Date(), params.get("time_zone") ?? undefined);
    const page = parsePaginationParams(params, "updatedAt");
    if (!page.ok) return page.response;
    return NextResponse.json(listReviewCards({ today, scope, source, limit: page.limit, cursor: page.updatedAtCursor }));
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: "分页参数或时区无效" }, { status: 400 });
    }
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/reviews", handleGet);
