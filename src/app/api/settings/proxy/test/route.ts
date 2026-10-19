import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { assertTrustedSettingsRequest } from "@/lib/settings-request";
import { readSettings } from "@/lib/settings";
import {
  normalizeProxyConfig,
  resolveIncomingProxyPassword,
} from "@/lib/proxy-config";
import { testProxyEndpoint } from "@/lib/proxy-detect";
import { errorMessage } from "@/lib/error-message";
import { NextResponse } from "next/server";

async function handlePost(request: Request) {
  try { assertTrustedSettingsRequest(request); }
  catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(request);
  if (!parsedBody.ok) {
    const body = await parsedBody.response.json().catch(() => null) as { error?: unknown } | null;
    return NextResponse.json(
      { ok: false, error: typeof body?.error === "string" ? body.error : "请求无效" },
      { status: parsedBody.response.status },
    );
  }
  try {
    if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
      throw new Error("请求体必须是 JSON 对象");
    }
    const body = parsedBody.data as Record<string, unknown>;
    for (const key of ["proxy_url", "proxy_username", "proxy_password"]) {
      if (Object.hasOwn(body, key) && typeof body[key] !== "string") {
        throw new Error(`${key} 必须是字符串`);
      }
    }
    const saved = readSettings();
    const config = normalizeProxyConfig({
      // 测试按钮应测试表单中的地址，即使保存的开关当前关闭。
      enabled: true,
      url: typeof body.proxy_url === "string" ? body.proxy_url : "",
      username: typeof body.proxy_username === "string" ? body.proxy_username : "",
      password: resolveIncomingProxyPassword(
        typeof body.proxy_password === "string" ? body.proxy_password : "",
        saved.proxy_password ?? "",
      ),
    });
    const result = await testProxyEndpoint(config);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 200 });
  }
}

export const POST = withRouteErrorHandling("POST /api/settings/proxy/test", handlePost);
