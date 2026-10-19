import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { authStatus } from "@/lib/auth";

/**
 * 公开的鉴权状态探针：登录页用它决定渲染初始化表单还是登录表单。
 * 只暴露布尔状态，不泄露用户名等任何凭证信息。
 */
async function handleGet() {
  return NextResponse.json(authStatus());
}

export const GET = withRouteErrorHandling("GET /api/auth/status", handleGet, { public: true });
