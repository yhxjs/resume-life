import { NextResponse } from "next/server";
import { logServerError, logServerEvent, requestIdFrom, withRequestIdScope } from "./server-errors";
import { assertDataGeneration, DataGenerationConflictError, withDataGenerationScope, withoutDataGenerationScope } from "./data-generation";
import { requestDataGeneration } from "./db";
import { DATA_GENERATION_HEADER, INITIAL_DATA_GENERATION } from "./data-generation-contract";
import { CorruptedTemplateError } from "./custom-templates";
import {
  renewSessionThrottled,
  resolveSession,
  sessionCookieHeaderValue,
  sessionTokenFromRequest,
} from "./auth";

type RouteContext = { params: Promise<Record<string, string>> };

/** 所有 API（含鉴权失败和异常）都可能涉及私人数据，统一禁止响应存储。 */
function noStore(response: Response): Response {
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("Cache-Control") ?? "")) {
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
}

type RouteOptions = {
  /**
   * 免鉴权端点（鉴权自身的 /api/auth/* 与探活 /api/health）显式声明；
   * 未声明时包装器先校验会话，无效返回 401，有效则滑动续期并刷新 cookie。
   * vitest 进程（NODE_ENV=test）跳过校验，与 db.ts 的测试豁免约定一致。
   */
  public?: boolean;
  /** 仅备份恢复可主动替换数据世代；不改变鉴权要求。 */
  allowDataRestore?: boolean;
  /** 仅健康探针自行打开并诊断数据库，不能在 handler 前建立依赖数据库的世代作用域。 */
  databaseProbe?: boolean;
};

/**
 * 统一鉴权、错误日志和带 requestId 的错误响应；operation 使用「方法 + 路径」。
 * 单参重载供无 params 调用，必填 context 重载置后以满足 Next 的路由类型推断。
 */
export function withRouteErrorHandling<Context extends RouteContext = RouteContext>(
  operation: string,
  handler: (request: Request, context: Context) => Response | Promise<Response>,
  options?: RouteOptions
): {
  (request: Request): Promise<Response>;
  (request: Request, context: Context): Promise<Response>;
} {
  return async (request: Request, context?: Context) => {
    try {
      const execute = () => {
        const generation = requestDataGeneration();
        const clientGeneration = request.headers.get(DATA_GENERATION_HEADER);
        if (!options?.public) {
          // 浏览器写请求必须绑定文档世代；脚本可显式携带该头。
          const browserMutation = /^(POST|PUT|PATCH|DELETE) /.test(operation) && request.headers.has("sec-fetch-site");
          if ((browserMutation && clientGeneration === null)
            || (clientGeneration !== null && clientGeneration !== (generation ?? INITIAL_DATA_GENERATION))) {
            throw new DataGenerationConflictError();
          }
        }
        return withDataGenerationScope(async () => {
          const response = await handler(request, context as Context);
          assertDataGeneration();
          response.headers.set(DATA_GENERATION_HEADER, generation ?? INITIAL_DATA_GENERATION);
          return response;
        }, generation);
      };
      const run = () => options?.allowDataRestore || options?.databaseProbe
        ? withoutDataGenerationScope(() => handler(request, context as Context))
        : execute();
      const invoke = async () => {
        const response = await withRequestIdScope(request, run);
        const requestId = requestIdFrom(request);
        response.headers.set("x-request-id", requestId);
        if (response.status === 502) {
          logServerEvent("warn", operation, { requestId, context: { status: "502" } });
        }
        return response;
      };
      if (!options?.public && process.env.NODE_ENV !== "test") {
        const token = sessionTokenFromRequest(request);
        const session = resolveSession(token);
        if (!session || !token) {
          return noStore(NextResponse.json({ error: "未登录或登录已过期，请重新登录" }, { status: 401 }));
        }
        // 滑动续期（带节流）：距上次续期不足 1 小时的请求跳过写库与 cookie 刷新，
        // 详见 renewSessionThrottled。
        const renewed = renewSessionThrottled(session);
        const response = await invoke();
        if (renewed) {
          response.headers.append("set-cookie", sessionCookieHeaderValue(token));
        }
        return noStore(response);
      }
      return noStore(await invoke());
    } catch (error) {
      if (error instanceof CorruptedTemplateError) {
        return noStore(NextResponse.json({ error: error.message, templateId: error.templateId }, { status: 422 }));
      }
      if (error instanceof DataGenerationConflictError) {
        return noStore(NextResponse.json({ error: error.message }, { status: 409 }));
      }
      const requestId = logServerError(operation, error, {
        requestId: requestIdFrom(request),
        status: 500,
      });
      return noStore(NextResponse.json({ error: "服务器内部错误，请稍后重试", requestId }, { status: 500 }));
    }
  };
}
