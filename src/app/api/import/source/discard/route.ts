import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { resolveSession, sessionTokenFromRequest } from "@/lib/auth";
import { readJsonBody, RequestFormatError, RequestTooLargeError } from "@/lib/request-limits";
import { isResumeImportSourceId } from "@/lib/resume-import-source-contract";
import { discardResumeImportSource, ResumeImportSourceGoneError } from "@/lib/resume-import-source";

async function handlePost(request: Request) {
  const session = resolveSession(sessionTokenFromRequest(request));
  if (!session) return NextResponse.json({ error: "未登录或登录已过期，请重新登录" }, { status: 401 });
  let body: unknown;
  try { body = await readJsonBody(request); }
  catch (error) {
    if (error instanceof RequestTooLargeError) return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    if (error instanceof RequestFormatError) return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, "sourceReceipt")
      || !isResumeImportSourceId((body as Record<string, unknown>).sourceReceipt)) {
    return NextResponse.json({ error: "文件来源编号格式无效" }, { status: 400 });
  }
  try { discardResumeImportSource(session.tokenHash, (body as { sourceReceipt: string }).sourceReceipt); }
  catch (error) {
    // Logout while reading the body already invalidated this session's sources.
    if (!(error instanceof ResumeImportSourceGoneError)) throw error;
  }
  return new Response(null, { status: 204 });
}

export const POST = withRouteErrorHandling("POST /api/import/source/discard", handlePost);
