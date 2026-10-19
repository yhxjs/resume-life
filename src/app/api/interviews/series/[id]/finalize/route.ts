import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import {
  finalizeSeries,
  interviewCommandMessage,
  interviewCommandStatus,
} from "@/lib/interview-commands";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const seriesId = Number((await params).id);
  if (!Number.isInteger(seriesId)) {
    return NextResponse.json({ error: "无效的进阶面试 ID" }, { status: 400 });
  }
  try {
    return NextResponse.json(await finalizeSeries(seriesId, req.signal));
  } catch (error) {
    return NextResponse.json(
      { error: interviewCommandMessage(error) },
      { status: interviewCommandStatus(error) }
    );
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/series/[id]/finalize", handlePost);

