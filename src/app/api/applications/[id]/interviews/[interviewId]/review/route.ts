import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import {
  InterviewReviewError,
  confirmInterviewReview,
  getInterviewReview,
  saveInterviewQuestions,
} from "@/lib/application-interview-review";

type Context = { params: Promise<{ id: string; interviewId: string }> };

async function ids(context: Context) {
  const params = await context.params;
  return { applicationId: Number(params.id), interviewId: Number(params.interviewId) };
}

function domainError(error: unknown): Response {
  if (error instanceof InterviewReviewError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

async function handleGet(request: Request, context: Context) {
  try {
    const { applicationId, interviewId } = await ids(context);
    const rawId = new URL(request.url).searchParams.get("recap_id");
    const recapId = rawId === null ? undefined : Number(rawId);
    return NextResponse.json(getInterviewReview(applicationId, interviewId, recapId));
  } catch (error) { return domainError(error); }
}

async function handlePut(request: Request, context: Context) {
  const parsed = await parseApiJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }
  try {
    const { applicationId, interviewId } = await ids(context);
    const value = body as Record<string, unknown>;
    return NextResponse.json(saveInterviewQuestions(applicationId, interviewId, value.questions, value.expected_hash as string));
  } catch (error) { return domainError(error); }
}

async function handlePost(request: Request, context: Context) {
  const parsed = await parseApiJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }
  try {
    const { applicationId, interviewId } = await ids(context);
    const expectedHash = (body as Record<string, unknown>).expected_hash;
    return NextResponse.json(await confirmInterviewReview(applicationId, interviewId, expectedHash as string, request.signal));
  } catch (error) { return domainError(error); }
}

export const GET = withRouteErrorHandling("GET /api/applications/[id]/interviews/[interviewId]/review", handleGet);
export const PUT = withRouteErrorHandling("PUT /api/applications/[id]/interviews/[interviewId]/review", handlePut);
export const POST = withRouteErrorHandling("POST /api/applications/[id]/interviews/[interviewId]/review", handlePost);
