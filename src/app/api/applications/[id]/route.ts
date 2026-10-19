import { withRouteErrorHandling } from "@/lib/api-route";
import { ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  ApplicationInputError,
  APPLICATION_STAGES,
  deleteApplication,
  getApplicationById,
  updateApplication,
  parseApplicationLifecycleInput,
  type ApplicationStage,
} from "@/lib/applications";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

/**
 * 关联 ID 的统一收口：undefined=未提供、null/""=清空、其余必须是 >=1 的整数。
 * 不做校验时 NaN 会一路传到 node:sqlite，由 TypeError 才失败（违反 fail-fast）。
 */
function parseOptionalId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new ApplicationInputError("关联记录 ID 无效");
  return n;
}

/** stage 白名单：非法值必须在此拦下，不能依赖 DB CHECK 的报错时机。
 *  fallback 缺省时，空值视为非法（PATCH 的部分更新语义：空串不是「清空 stage」）。 */
function parseStage(value: unknown, fallback?: ApplicationStage): ApplicationStage {
  if (value === undefined || value === null || value === "") {
    if (fallback) return fallback;
    throw new ApplicationInputError("投递阶段无效");
  }
  if (typeof value !== "string" || !APPLICATION_STAGES.includes(value as ApplicationStage)) {
    throw new ApplicationInputError("投递阶段无效");
  }
  return value as ApplicationStage;
}

async function handleGet(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: rawId } = await params;
  const id = Number(rawId);
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
  const id = Number(rawId);
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

  if (!body) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }

  try {
    const updated = updateApplication(id, {
      ...parseApplicationLifecycleInput(body),
      company: typeof body.company === "string" ? body.company : undefined,
      role: typeof body.role === "string" ? body.role : undefined,
      salary_range: typeof body.salary_range === "string" ? body.salary_range : undefined,
      // 仅字符串更新 stage，且必须通过枚举校验。
      stage: typeof body.stage === "string" ? parseStage(body.stage) : undefined,
      resume_id: parseOptionalId(body.resume_id),
      resume_version_id: parseOptionalId(body.resume_version_id),
      jd: typeof body.jd === "string" ? body.jd : undefined,
      interview_id: parseOptionalId(body.interview_id),
      interview_series_id: parseOptionalId(body.interview_series_id),
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
  const id = Number(rawId);
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
