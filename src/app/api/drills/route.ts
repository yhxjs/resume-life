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
  const body = parsedBody.data as {
    source?: unknown;
    project_id?: unknown;
    direction?: unknown;
    jd?: unknown;
    interview_id?: unknown;
    count?: unknown;
  } | null;
  const count = Math.min(Math.max(Math.trunc(Number(body?.count) || 5), 1), MAX_DRILL_QUESTIONS);
  const payload = body ?? {};

  let drill: CreatedDrill;
  try {
    drill =
      payload.source === "bank"
        ? await createBankDrill(payload, count, req.signal)
        : payload.source === "interview"
          ? await createInterviewDrill(payload, count, req.signal)
          : await createProjectDrill(payload, count, req.signal);
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
  const projectId = Number(url.searchParams.get("project_id"));
  const q = (url.searchParams.get("q") ?? "").trim();


  return NextResponse.json(listDrills(projectId, q, cursor, limit));

}

export const POST = withRouteErrorHandling("POST /api/drills", handlePost);
export const GET = withRouteErrorHandling("GET /api/drills", handleGet);
