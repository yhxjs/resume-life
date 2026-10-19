import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import {
  SESSION_COOKIE_NAME,
  AuthInputError,
  AuthRateLimitError,
  sessionCookieOptions,
  isInitialized,
  loginSession,
} from "@/lib/auth";

type LoginBody = {
  username?: unknown;
  password?: unknown;
};

async function handlePost(request: Request) {
  if (!isInitialized()) {
    return NextResponse.json({ error: "尚未初始化用户名和密码" }, { status: 400 });
  }

  const parsedBody = await parseApiJson<LoginBody>(request);
  if (!parsedBody.ok) return parsedBody.response;
  if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const { username, password } = parsedBody.data;
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "用户名和密码必须是字符串" }, { status: 400 });
  }

  let session: Awaited<ReturnType<typeof loginSession>>;
  try {
    session = await loginSession(username, password);
    if (!session) {
      return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    }
  } catch (error) {
    if (error instanceof AuthInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof AuthRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": String(error.retryAfter) } });
    }
    throw error;
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session.token,
    ...sessionCookieOptions(),
  });
  return response;
}

export const POST = withRouteErrorHandling("POST /api/auth/login", handlePost, { public: true });
