import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  ApplicationInputError,
  assertApplicationInterviewTextInput,
  parseInterviewRoundStatus,
  createApplicationInterview,
  getApplicationById,
  listApplicationInterviews,
  parseInterviewReminderMinutes,
  parseInterviewAdvanceStage,
} from "@/lib/applications";

async function handleGet(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = parseCanonicalPositiveId(rawId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "无效的投递 ID" }, { status: 400 });
  }

  const app = getApplicationById(id);
  if (!app) {
    return NextResponse.json({ error: "投递记录不存在" }, { status: 404 });
  }

  const interviews = listApplicationInterviews(id);
  return NextResponse.json(interviews);
}

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = parseCanonicalPositiveId(rawId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "无效的投递 ID" }, { status: 400 });
  }

  const app = getApplicationById(id);
  if (!app) {
    return NextResponse.json({ error: "投递记录不存在" }, { status: 404 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    round_name?: unknown;
    interview_time?: unknown;
    status?: unknown;
    interviewer?: unknown;
    location?: unknown;
    meeting_url?: unknown;
    reminder_minutes?: unknown;
    notes?: unknown;
    advance_stage?: unknown;
  } | null;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }

  const roundName = typeof body.round_name === "string" ? body.round_name.trim() : "";
  if (!roundName) {
    return NextResponse.json({ error: "面试轮次名称不能为空" }, { status: 400 });
  }

  try {
    assertApplicationInterviewTextInput(body);
    const interview = createApplicationInterview(id, {
      round_name: roundName,
      interview_time: typeof body.interview_time === "string" ? body.interview_time : "",
      status: parseInterviewRoundStatus(body.status, "scheduled"),
      interviewer: typeof body.interviewer === "string" ? body.interviewer : "",
      location: typeof body.location === "string" ? body.location : "",
      meeting_url: typeof body.meeting_url === "string" ? body.meeting_url : "",
      reminder_minutes: parseInterviewReminderMinutes(body.reminder_minutes),
      notes: typeof body.notes === "string" ? body.notes : "",
    }, { advanceStage: parseInterviewAdvanceStage(body.advance_stage) });

    return NextResponse.json(interview, { status: 201 });
  } catch (err) {
    if (err instanceof ApplicationInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export const GET = withRouteErrorHandling("GET /api/applications/[id]/interviews", handleGet);
export const POST = withRouteErrorHandling("POST /api/applications/[id]/interviews", handlePost);
