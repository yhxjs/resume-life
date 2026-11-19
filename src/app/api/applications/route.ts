import { withRouteErrorHandling } from "@/lib/api-route";
import { ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  ApplicationInputError,
  assertApplicationTextInput,
  parseApplicationStage,
  createApplication,
  parseApplicationRelatedIds,
  parseApplicationLifecycleInput,
  listApplications,
} from "@/lib/applications";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { parsePaginationParams } from "@/lib/cursor-pagination";

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const pagination = parsePaginationParams(url.searchParams, "updatedAt");
  if (!pagination.ok) return pagination.response;
  const { limit, updatedAtCursor: cursor } = pagination;
  const stage = url.searchParams.get("stage") || undefined;
  const q = url.searchParams.get("q") || undefined;
  const upcomingOnly = url.searchParams.get("upcoming") === "1";

  try {
    const page = listApplications({ stage, q, upcomingOnly, limit, cursor });
    return NextResponse.json(page);
  } catch (err) {
    const requestId = logServerError("applications.list", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json(
      { error: "读取投递记录失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    company?: unknown;
    role?: unknown;
    salary_range?: unknown;
    stage?: unknown;
    batch_name?: unknown;
    hiring_stage?: unknown;
    terminal_stage?: unknown;
    terminal_reason?: unknown;
    resume_id?: unknown;
    resume_version_id?: unknown;
    jd?: unknown;
    interview_id?: unknown;
    interview_series_id?: unknown;
    next_interview_at?: unknown;
    notes?: unknown;
  } | null;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }

  const company = typeof body.company === "string" ? body.company.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (!company) return NextResponse.json({ error: "公司名称不能为空" }, { status: 400 });
  if (!role) return NextResponse.json({ error: "岗位名称不能为空" }, { status: 400 });

  try {
    assertApplicationTextInput(body);
    const app = createApplication({
      ...parseApplicationLifecycleInput(body),
      ...parseApplicationRelatedIds(body),
      company,
      role,
      salary_range: typeof body.salary_range === "string" ? body.salary_range : "",
      stage: parseApplicationStage(body.stage, "interested"),
      jd: typeof body.jd === "string" ? body.jd : "",
      next_interview_at: typeof body.next_interview_at === "string" ? body.next_interview_at : "",
      notes: typeof body.notes === "string" ? body.notes : "",
    });
    return NextResponse.json(app, { status: 201 });
  } catch (err) {
    if (err instanceof ApplicationInputError || err instanceof ResumeVersionError) {
      return NextResponse.json({ error: err.message }, { status: err instanceof ResumeVersionError ? err.status : 400 });
    }
    // 内部故障交给外层 withRouteErrorHandling：logServerError + requestId 500
    throw err;
  }
}

export const GET = withRouteErrorHandling("GET /api/applications", handleGet);
export const POST = withRouteErrorHandling("POST /api/applications", handlePost);
