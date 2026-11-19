import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { isResumeCreationRequestId } from "@/lib/resume-creation-contract";
import { readResumeCreationRequest } from "@/lib/resume-creation";

export const GET = withRouteErrorHandling("GET /api/resumes/requests/[requestId]", async (_req, context) => {
  const { requestId } = await context.params;
  if (!isResumeCreationRequestId(requestId)) return NextResponse.json({ error: "创建请求编号无效" }, { status: 400 });
  const receipt = readResumeCreationRequest(requestId);
  return receipt ? NextResponse.json({ request_id: requestId, ...receipt })
    : NextResponse.json({ error: "尚未找到该创建请求，请稍后核对；请求仍可能在途中" }, { status: 404 });
});
