import { NextResponse, type NextRequest } from "next/server";
import { validateMutationOrigin } from "@/lib/api-origin";
import { SESSION_COOKIE_NAME } from "@/lib/auth-constants";

export const config = {
  // 除 Next 内部资源与公开静态文件外全部经过 proxy：页面、API 与 uploads 一并覆盖
  matcher: ["/((?!_next/|favicon.ico|logo.png|icon.png).*)"],
};

/**
 * proxy 只做网络层职责（Host 白名单、uploads 封禁、页面未登录重定向），
 * 刻意不引入数据库模块：middleware 的构建产物会被源码级 NFT 分析静态解析出
 * 数据目录，把真实数据库卷进部署追踪（outputFileTracingExcludes 在 Turbopack
 * 构建下不生效）。API 的会话鉴权统一收口在 withRouteErrorHandling（见
 * src/lib/api-route.ts），服务端渲染读库的页面（首页）自行校验会话。
 */
export function proxy(request: NextRequest) {
  const originResult = validateMutationOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: "拒绝非本机来源的 API 请求" }, { status: originResult.status });
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith("/uploads/")) {
    return new NextResponse(null, { status: 404 });
  }

  // API 的鉴权由路由统一包装器负责（含公开端点 /api/auth/* 与 /api/health），
  // /login 页面自身公开；其余页面只做 cookie 在场检查即可快速重定向——
  // 页面不含数据，伪造或过期的 cookie 会被首个 API 401 打回登录页。
  if (url.pathname.startsWith("/api/") || url.pathname === "/login") {
    return NextResponse.next();
  }
  if (!request.cookies.has(SESSION_COOKIE_NAME)) {
    const loginUrl = new URL("/login", request.url);
    if (url.pathname !== "/") {
      loginUrl.searchParams.set("next", `${url.pathname}${url.search}`);
    }
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}
