import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  ApplicationInputError,
  INTERVIEW_ROUND_STATUSES,
  deleteApplicationInterview,
  getApplicationById,
  getApplicationInterviewById,
  parseInterviewReminderMinutes,
  updateApplicationInterview,
  type InterviewRoundStatus,
} from "@/lib/applications";

async function handlePatch(
  req: Request,
  { params }: { params: Promise<{ id: string; interviewId: string }> }
) {
  const { id: rawAppId, interviewId: rawInterviewId } = await params;
  const appId = Number(rawAppId);
  const interviewId = Number(rawInterviewId);

  if (!Number.isInteger(appId) || !Number.isInteger(interviewId)) {
    return NextResponse.json({ error: "无效的请求参数 ID" }, { status: 400 });
  }

  const app = getApplicationById(appId);
  if (!app) {
    return NextResponse.json({ error: "投递记录不存在" }, { status: 404 });
  }

  const interview = getApplicationInterviewById(interviewId);
  if (!interview || interview.application_id !== appId) {
    return NextResponse.json({ error: "面试轮次记录不存在" }, { status: 404 });
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
  } | null;

  if (!body) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }

  if (body.status !== undefined && body.status !== null) {
    if (typeof body.status !== "string" || !INTERVIEW_ROUND_STATUSES.includes(body.status as InterviewRoundStatus)) {
      return NextResponse.json({ error: "面试轮次状态无效" }, { status: 400 });
    }
  }

  try {
    const updated = updateApplicationInterview(interviewId, {
      round_name: typeof body.round_name === "string" ? body.round_name : undefined,
      interview_time: typeof body.interview_time === "string" ? body.interview_time : undefined,
      status: typeof body.status === "string" ? (body.status as InterviewRoundStatus) : undefined,
      interviewer: typeof body.interviewer === "string" ? body.interviewer : undefined,
      location: typeof body.location === "string" ? body.location : undefined,
      meeting_url: typeof body.meeting_url === "string" ? body.meeting_url : undefined,
      reminder_minutes: body.reminder_minutes === undefined ? undefined : parseInterviewReminderMinutes(body.reminder_minutes),
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ApplicationInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

async function handleDelete(
  _req: Request,
  { params }: { params: Promise<{ id: string; interviewId: string }> }
) {
  const { id: rawAppId, interviewId: rawInterviewId } = await params;
  const appId = Number(rawAppId);
  const interviewId = Number(rawInterviewId);

  if (!Number.isInteger(appId) || !Number.isInteger(interviewId)) {
    return NextResponse.json({ error: "无效的请求参数 ID" }, { status: 400 });
  }

  const interview = getApplicationInterviewById(interviewId);
  if (!interview || interview.application_id !== appId) {
    return NextResponse.json({ error: "面试轮次记录不存在" }, { status: 404 });
  }

  deleteApplicationInterview(interviewId);
  return NextResponse.json({ ok: true });
}

export const PATCH = withRouteErrorHandling(
  "PATCH /api/applications/[id]/interviews/[interviewId]",
  handlePatch
);
export const DELETE = withRouteErrorHandling(
  "DELETE /api/applications/[id]/interviews/[interviewId]",
  handleDelete
);
