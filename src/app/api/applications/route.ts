import { withRouteErrorHandling } from "@/lib/api-route";
import { ResumeVersionError } from "@/lib/resume-versions";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  ApplicationInputError,
  APPLICATION_STAGES,
  createApplication,
  parseApplicationLifecycleInput,
  listApplications,
  type ApplicationStage,
} from "@/lib/applications";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { parsePaginationParams } from "@/lib/cursor-pagination";

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

  if (!body) {
    return NextResponse.json({ error: "请求数据无效" }, { status: 400 });
  }

  const company = typeof body.company === "string" ? body.company.trim() : "";
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (!company) return NextResponse.json({ error: "公司名称不能为空" }, { status: 400 });
  if (!role) return NextResponse.json({ error: "岗位名称不能为空" }, { status: 400 });

  try {
    const app = createApplication({
      ...parseApplicationLifecycleInput(body),
      company,
      role,
      salary_range: typeof body.salary_range === "string" ? body.salary_range : "",
      stage: parseStage(body.stage, "interested"),
      resume_id: parseOptionalId(body.resume_id) ?? null,
      resume_version_id: parseOptionalId(body.resume_version_id),
      jd: typeof body.jd === "string" ? body.jd : "",
      interview_id: parseOptionalId(body.interview_id) ?? null,
      interview_series_id: parseOptionalId(body.interview_series_id) ?? null,
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
