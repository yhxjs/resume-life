import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ApplicationInputError } from "@/lib/applications";
import { createResume } from "@/lib/resume-creation";
import type { ResumeVersionSummary } from "@/lib/resume-version-types";

async function handleGet() {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, title, created_at, updated_at FROM resumes ORDER BY updated_at DESC")
    .all() as { id: number; title: string; created_at: string; updated_at: string }[];
  const versions = db.prepare("SELECT id, resume_id, version, name FROM resume_versions ORDER BY version DESC").all() as (ResumeVersionSummary & { resume_id: number })[];
  const byResume = new Map<number, ResumeVersionSummary[]>();
  for (const { resume_id, ...version } of versions) {
    const list = byResume.get(resume_id) ?? [];
    list.push(version);
    byResume.set(resume_id, list);
  }
  return NextResponse.json(rows.map((row) => ({ ...row, versions: byResume.get(row.id) ?? [] })));
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    return NextResponse.json(createResume(parsedBody.data), { status: 201 });
  } catch (error) {
    if (error instanceof ApplicationInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/resumes", handleGet);
export const POST = withRouteErrorHandling("POST /api/resumes", handlePost);
