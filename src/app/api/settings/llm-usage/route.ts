import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { InvalidUsageRangeError, parseFeature, parseIsoRange, parseUsageTimeZone, summarizeLlmUsage } from "@/lib/llm-call-log";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

/** 用量看板汇总。只返回原始累加值与上报次数，命中率由前端派生。 */
async function handleGet(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const range = parseIsoRange(params);
    const feature = parseFeature(params.get("feature"));
    const timeZone = parseUsageTimeZone(params.get("timeZone"));
    return NextResponse.json(summarizeLlmUsage({ ...range, feature, timeZone }));
  } catch (err) {
    const invalid = err instanceof InvalidUsageRangeError;
    const status = invalid ? 400 : 500;
    const requestId = logServerError("settings.llm-usage", err, { requestId: requestIdFrom(request), status });
    return NextResponse.json(
      { error: invalid ? err.message : "读取用量统计失败，请稍后重试", requestId },
      { status }
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/settings/llm-usage", handleGet);
