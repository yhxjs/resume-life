import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { branchResumeVersion, ResumeVersionError } from "@/lib/resume-versions";

async function handlePost(request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const raw = await params;
  const id = Number(raw.id);
  const versionId = Number(raw.versionId);
  if (![id, versionId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return NextResponse.json({ error: "简历或版本 ID 无效" }, { status: 400 });
  }
  const parsed = await parseApiJson<unknown>(request);
  if (!parsed.ok) return parsed.response;
  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  }
  const revision = (parsed.data as Record<string, unknown>).draft_revision;
  if (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
    return NextResponse.json({ error: "请刷新版本页面后再创建分支" }, { status: 409 });
  }
  try { return NextResponse.json(branchResumeVersion(id, versionId, revision)); }
  catch (error) {
    if (error instanceof ResumeVersionError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const POST = withRouteErrorHandling("POST /api/resumes/[id]/versions/[versionId]/branch", handlePost);
