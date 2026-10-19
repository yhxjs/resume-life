import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";

/** 供前端判断「AI 服务是否已配置」，不返回任何敏感字段 */
async function handleGet() {
  const s = readSettings();
  return NextResponse.json({
    configured: Boolean(s.base_url && s.api_key),
  });
}

export const GET = withRouteErrorHandling("GET /api/settings/configured", handleGet);
