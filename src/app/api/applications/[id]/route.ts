import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  ApplicationInputError,
  assertApplicationTextInput,
  parseApplicationStage,
  deleteApplication,
  getApplicationById,
  parseApplicationRelatedIds,
  updateApplication,
  parseApplicationLifecycleInput,
} from "@/lib/applications";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

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

  return NextResponse.json(app);
}

async function handlePatch(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = parseCanonicalPositiveId(rawId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "无效的投递 ID" }, { status: 400 });
  }

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

  try {
    assertApplicationTextInput(body);
    const updated = updateApplication(id, {
      ...parseApplicationLifecycleInput(body),
      ...parseApplicationRelatedIds(body),
      company: typeof body.company === "string" ? body.company : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
      salary_range: typeof body.salary_range === "string" ? body.salary_range : undefined,
      stage: body.stage === undefined ? undefined : parseApplicationStage(body.stage),
      jd: typeof body.jd === "string" ? body.jd : undefined,
      next_interview_at: typeof body.next_interview_at === "string" ? body.next_interview_at : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof ApplicationInputError || err instanceof ResumeVersionError) {
      return NextResponse.json({ error: err.message }, { status: err instanceof ResumeVersionError ? err.status : 400 });
    }
    throw err;
  }
}

async function handleDelete(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = parseCanonicalPositiveId(rawId);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "无效的投递 ID" }, { status: 400 });
  }

  try {
    // 与全仓其余 DELETE 端点一致：目标不存在时返回 404，而不是幂等 200
    if (!deleteApplication(id)) {
      return NextResponse.json({ error: "投递记录不存在" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const requestId = logServerError("applications.delete", err, {
      requestId: requestIdFrom(req), status: 500, context: { resourceId: id },
    });
    return NextResponse.json(
      { error: "删除投递记录失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/applications/[id]", handleGet);
export const PATCH = withRouteErrorHandling("PATCH /api/applications/[id]", handlePatch);
export const DELETE = withRouteErrorHandling("DELETE /api/applications/[id]", handleDelete);
