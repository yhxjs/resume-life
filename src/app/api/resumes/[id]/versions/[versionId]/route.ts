import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { getResumeVersion } from "@/lib/resume-versions";

async function handleGet(_request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const raw = await params;
  const id = Number(raw.id);
  const versionId = Number(raw.versionId);
  if (![id, versionId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return NextResponse.json({ error: "简历或版本 ID 无效" }, { status: 400 });
  }
  const version = getResumeVersion(id, versionId);
  return version ? NextResponse.json(version) : NextResponse.json({ error: "简历版本不存在" }, { status: 404 });
}

export const GET = withRouteErrorHandling("GET /api/resumes/[id]/versions/[versionId]", handleGet);
