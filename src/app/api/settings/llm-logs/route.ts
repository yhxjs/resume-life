import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { InvalidUsageRangeError, listLlmCalls, parseFeature, parseIsoRange } from "@/lib/llm-call-log";
import { parsePaginationParams } from "@/lib/cursor-pagination";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

/** 调用日志列表，按 id 倒序游标分页。 */
async function handleGet(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const range = parseIsoRange(params);
    const feature = parseFeature(params.get("feature"));
    const page = parsePaginationParams(params);
    if (!page.ok) return page.response;
    return NextResponse.json(
      listLlmCalls({
        ...range,
        feature,
        limit: page.limit,
        cursor: page.idCursor,
      })
    );
  } catch (err) {
    const invalid = err instanceof InvalidUsageRangeError;
    const status = invalid ? 400 : 500;
    const requestId = logServerError("settings.llm-logs", err, { requestId: requestIdFrom(request), status });
    return NextResponse.json(
      { error: invalid ? err.message : "读取调用日志失败，请稍后重试", requestId },
      { status }
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/settings/llm-logs", handleGet);
