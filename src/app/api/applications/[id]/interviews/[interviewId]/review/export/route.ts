import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { exportInterviewReview, InterviewReviewError } from "@/lib/application-interview-review";

type Context = { params: Promise<{ id: string; interviewId: string }> };

async function handlePost(request: Request, { params }: Context) {
  const parsed = await parseApiJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }
  try {
    const { id, interviewId } = await params;
    const input = body as Record<string, unknown>;
    return NextResponse.json(exportInterviewReview(Number(id), Number(interviewId), input.recap_id, input.action));
  } catch (error) {
    if (error instanceof InterviewReviewError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const POST = withRouteErrorHandling("POST /api/applications/[id]/interviews/[interviewId]/review/export", handlePost);
