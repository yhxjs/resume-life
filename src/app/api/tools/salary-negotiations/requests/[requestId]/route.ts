import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { isSalaryCreationRequestId, readSalaryCreationRequest } from "@/lib/salary-creation-requests";

export const GET = withRouteErrorHandling("GET /api/tools/salary-negotiations/requests/[requestId]", async (_req, context) => {
  const { requestId } = await context.params;
  if (!isSalaryCreationRequestId(requestId)) return NextResponse.json({ error: "创建请求编号无效" }, { status: 400 });
  const state = readSalaryCreationRequest(requestId);
  return state ? NextResponse.json({ request_id: requestId, ...state }) : NextResponse.json({ error: "尚未找到该创建请求；请稍后重新核对，不要直接重复创建" }, { status: 404 });
});
