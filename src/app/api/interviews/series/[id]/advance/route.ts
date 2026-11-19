import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { parseApiJson } from "@/lib/api-request";
import {
  InterviewCommandError,
  advanceSeries,
  interviewCommandMessage,
  interviewCommandStatus,
} from "@/lib/interview-commands";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const seriesId = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
    return NextResponse.json({ error: "无效的进阶面试 ID" }, { status: 400 });
  }
  const body = await parseApiJson<unknown>(req);
  if (!body.ok) return body.response;
  const input = body.data;
  const fromId = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).from_interview_id : undefined;
  if (typeof fromId !== "number" || !Number.isSafeInteger(fromId) || fromId <= 0) {
    return NextResponse.json({ error: "请指定有效的上一轮面试 ID" }, { status: 400 });
  }
  try {
    return NextResponse.json(await advanceSeries(seriesId, fromId, req.signal), { status: 201 });
  } catch (error) {
    if (!(error instanceof InterviewCommandError)) throw error;
    return NextResponse.json(
      { error: interviewCommandMessage(error) },
      { status: interviewCommandStatus(error) }
    );
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/series/[id]/advance", handlePost);
