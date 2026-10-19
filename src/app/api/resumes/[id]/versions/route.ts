import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { listResumeVersions, publishResumeVersion, ResumeVersionError } from "@/lib/resume-versions";

type Context = { params: Promise<{ id: string }> };

async function handleGet(_request: Request, { params }: Context) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  try { return NextResponse.json(listResumeVersions(id)); }
  catch (error) {
    if (error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

async function handlePost(request: Request, { params }: Context) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "无效的简历 ID" }, { status: 400 });
  const parsed = await parseApiJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  const value = body as Record<string, unknown>;
  if (typeof value.name !== "string" || (value.description !== undefined && typeof value.description !== "string") ||
      (value.draft_revision !== undefined && typeof value.draft_revision !== "string")) {
    return NextResponse.json({ error: "版本参数无效" }, { status: 400 });
  }
  if (typeof value.draft_revision !== "string" || !/^[a-f0-9]{64}$/.test(value.draft_revision)) {
    return NextResponse.json({ error: "请刷新简历后再发布版本" }, { status: 409 });
  }
  try {
    return NextResponse.json(publishResumeVersion(id, {
      name: value.name, description: value.description as string | undefined, draft_revision: value.draft_revision,
    }), { status: 201 });
  } catch (error) {
    if (error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]/versions", handleGet);
export const POST = withRouteErrorHandling("POST /api/resumes/[id]/versions", handlePost);
