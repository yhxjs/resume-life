import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { SESSION_COOKIE_NAME, revokeSession, sessionTokenFromRequest, sessionCookieOptions } from "@/lib/auth";

/**
 * 退出登录：撤销服务端会话并清掉 cookie。不做鉴权门槛——
 * 会话已过期时也应能幂等地完成清理，且该操作不泄露任何数据。
 */
async function handlePost(request: Request) {
  revokeSession(sessionTokenFromRequest(request));
  const response = NextResponse.json({ ok: true });
  response.cookies.set({ name: SESSION_COOKIE_NAME, value: "", ...sessionCookieOptions(0) });
  return response;
}

export const POST = withRouteErrorHandling("POST /api/auth/logout", handlePost, { public: true });
