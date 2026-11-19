import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";

import { parseApiJson } from "@/lib/api-request";

import { NextResponse } from "next/server";

import { createBankDrill, createInterviewDrill, createProjectDrill, HttpError, type CreatedDrill } from "@/lib/drills-create";
import { MAX_DRILL_QUESTIONS } from "@/lib/drills-questions";

import { listDrills } from "@/lib/drills-list";

import { parsePaginationParams } from "@/lib/cursor-pagination";

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
    return NextResponse.json({ error: "练习请求必须是 JSON 对象" }, { status: 400 });
  }
  const body = parsedBody.data as {
    source?: unknown;
    project_id?: unknown;
    direction?: unknown;
    jd?: unknown;
    interview_id?: unknown;
    count?: unknown;
  };
  if (body.source !== undefined && body.source !== "project" && body.source !== "bank" && body.source !== "interview") {
    return NextResponse.json({ error: "无效的练习来源" }, { status: 400 });
  }
  if (body.count !== undefined && (typeof body.count !== "number" || !Number.isFinite(body.count))) {
    return NextResponse.json({ error: "练习题量必须是有限数字" }, { status: 400 });
  }
  if ((body.direction !== undefined && typeof body.direction !== "string") ||
    (body.jd !== undefined && typeof body.jd !== "string")) {
    return NextResponse.json({ error: "岗位方向和 JD 必须是字符串" }, { status: 400 });
  }
  const count = Math.min(Math.max(Math.trunc(body.count || 5), 1), MAX_DRILL_QUESTIONS);

  let drill: CreatedDrill;
  try {
    drill =
      body.source === "bank"
        ? await createBankDrill(body, count, req.signal)
        : body.source === "interview"
          ? await createInterviewDrill(body, count, req.signal)
          : await createProjectDrill(body, count, req.signal);
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  return NextResponse.json(drill, { status: 201 });
}

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const page = parsePaginationParams(url.searchParams);
  if (!page.ok) return page.response;
  const { limit, idCursor: cursor } = page;
  const projectParam = url.searchParams.get("project_id");
  const projectId = projectParam === null ? null : parseCanonicalPositiveId(projectParam);
  if (projectParam !== null && !Number.isSafeInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目筛选" }, { status: 400 });
  }
  const q = (url.searchParams.get("q") ?? "").trim();


  return NextResponse.json(listDrills(projectId, q, cursor, limit));

}

export const POST = withRouteErrorHandling("POST /api/drills", handlePost);
export const GET = withRouteErrorHandling("GET /api/drills", handleGet);
