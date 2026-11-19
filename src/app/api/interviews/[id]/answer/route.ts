import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  InterviewCommandError,
  interviewCommandMessage,
  interviewCommandStatus,
  prepareAnswerInterview,
} from "@/lib/interview-commands";
import { createSseResponse } from "@/lib/sse";
import { requestIdFrom } from "@/lib/server-errors";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const interviewId = parseCanonicalPositiveId((await params).id);
  if (!Number.isSafeInteger(interviewId) || interviewId <= 0) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { turn_id?: unknown; answer?: unknown } | null;
  const turnId = body?.turn_id;
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  if (typeof turnId !== "number" || !Number.isSafeInteger(turnId) || turnId <= 0) return NextResponse.json({ error: "无效的轮次 ID" }, { status: 400 });
  if (!answer) return NextResponse.json({ error: "回答内容不能为空" }, { status: 400 });
  const requestId = requestIdFrom(req);
  try {
    const execute = prepareAnswerInterview({ interviewId, turnId, answer, requestSignal: req.signal, requestId });
    return createSseResponse(execute, requestId);
  } catch (error) {
    if (!(error instanceof InterviewCommandError)) throw error;
    return NextResponse.json(
      { error: interviewCommandMessage(error) },
      { status: interviewCommandStatus(error) }
    );
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/[id]/answer", handlePost);
