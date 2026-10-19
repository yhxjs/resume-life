import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import {
  AuthInputError,
  AuthAlreadyInitializedError,
  SESSION_COOKIE_NAME,
  clearReinitFlag,
  sessionCookieOptions,
  authStatus,
  createSession,
  initializeCredentials,
} from "@/lib/auth";

type InitBody = {
  username?: unknown;
  password?: unknown;
};

function isLoopbackRequest(request: Request): boolean {
  const rawHost = request.headers.get("host") ?? new URL(request.url).host;
  const hostname = rawHost.startsWith("[")
    ? rawHost.slice(1, rawHost.indexOf("]"))
    : rawHost.split(":", 1)[0]!;
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * 初始化（或重新初始化）用户名和密码。放行条件：
 * - 尚未初始化且请求来自回环 Host：首次启动的正常路径；
 * - 已初始化但 RESUME_LIFE_AUTH_REINIT=true：忘记密码时的逃生门，其余数据不受影响。
 * 成功后直接为当前浏览器签发会话，免去再手动登录一次。
 */
async function handlePost(request: Request) {
  if (!isLoopbackRequest(request)) {
    return NextResponse.json(
      { error: "初始化只允许通过本机回环地址使用，请在服务器本机或 SSH 隧道中操作" },
      { status: 403 },
    );
  }
  const { initialized, allowReinit } = authStatus();
  if (initialized && !allowReinit) {
    return NextResponse.json(
      { error: "已初始化过用户名和密码；如需重新初始化，请将环境变量 RESUME_LIFE_AUTH_REINIT 设置为 true 后重启应用" },
      { status: 403 },
    );
  }
  const parsedBody = await parseApiJson<InitBody>(request);
  if (!parsedBody.ok) return parsedBody.response;
  if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
    return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  }
  const { username, password } = parsedBody.data;
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "用户名和密码必须是字符串" }, { status: 400 });
  }

  let reinitialized: boolean;
  try {
    reinitialized = initializeCredentials(username, password);
  } catch (error) {
    if (error instanceof AuthAlreadyInitializedError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof AuthInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (reinitialized && allowReinit) clearReinitFlag();

  const session = createSession();
  const response = NextResponse.json({ ok: true, reinitialized });
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: session.token,
    ...sessionCookieOptions(),
  });
  return response;
}

export const POST = withRouteErrorHandling("POST /api/auth/init", handlePost, { public: true });
