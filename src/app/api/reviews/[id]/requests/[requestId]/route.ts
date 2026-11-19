import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { getReviewSubmission } from "@/lib/spaced-repetition-cards";

type Context = { params: Promise<{ id: string; requestId: string }> };
export const GET = withRouteErrorHandling("GET /api/reviews/[id]/requests/[requestId]", async (_req: Request, { params }: Context) => {
  const { id, requestId } = await params;
  const reviewId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    return NextResponse.json({ error: "无效的复习提交编号" }, { status: 400 });
  }
  const saved = getReviewSubmission(reviewId, requestId);
  return saved ? NextResponse.json(saved) : NextResponse.json({ error: "当前未找到该次复习提交" }, { status: 404 });
});
