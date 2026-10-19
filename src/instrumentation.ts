import type { Instrumentation } from "next";
import { logServerError } from "@/lib/server-errors";

/** 进程启动时打印一次生效环境摘要（不含密钥、路径与个人资料），排障时可直接对照。 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logNodeStartup } = await import("./instrumentation-node");
    await logNodeStartup();
  }
}

/** Next 捕获到未处理的服务端异常时，记录不含正文与堆栈的关联诊断元数据。 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const header = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "x-request-id")?.[1];
  logServerError("next.request", error, {
    requestId: typeof header === "string" ? header : undefined,
    status: 500,
    context: {
      route: context.routePath,
      method: request.method,
    },
  });
};
