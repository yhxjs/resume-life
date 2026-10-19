import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import {
  API_KEY_MASK_PREFIX,
  SETTINGS_FIELDS,
  maskApiKey,
  readSettings,
  resolveIncomingApiKey,
  writeSettings,
  type SettingsPayload,
} from "@/lib/settings";
import { parseMaxOutputTokens, VALID_API_FORMATS, VALID_OCR_MODES, type ApiFormat, type OcrMode } from "@/lib/settings-constants";
import { assertTrustedSettingsRequest, describePrivateBaseUrl, parseHttpBaseUrl } from "@/lib/settings-request";
import { normalizeProxyConfig, maskProxyPassword, resolveIncomingProxyPassword } from "@/lib/proxy-config";
import { SettingsSecretError } from "@/lib/secret-store";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

async function handleGet() {
  const saved = readSettings();
  // 代理 URL 不回显 userinfo，凭证只通过独立密码字段存储。
  const publicProxy = normalizeProxyConfig({
    enabled: false,
    url: saved.proxy_url ?? "",
    username: saved.proxy_username ?? "",
    password: saved.proxy_password ?? "",
  });
  // api_key 只回脱敏占位符，完整密钥不出服务端
  return NextResponse.json({
    ...saved,
    api_key: maskApiKey(saved.api_key),
    proxy_url: publicProxy.url,
    proxy_username: publicProxy.username,
    proxy_password: maskProxyPassword(publicProxy.password),
  });
}

async function handlePut(req: Request) {
  try { assertTrustedSettingsRequest(req); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "设置请求无效" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as unknown;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求体无效" }, { status: 400 });
  }
  const o = body as Record<string, unknown>;
  if (Object.hasOwn(o, "api_format") && (typeof o.api_format !== "string" || !VALID_API_FORMATS.has(o.api_format.trim() as ApiFormat))) {
    return NextResponse.json({ error: "api_format 必须是受支持的协议字符串" }, { status: 400 });
  }
  if (Object.hasOwn(o, "ocr_mode") && (typeof o.ocr_mode !== "string" || !VALID_OCR_MODES.has(o.ocr_mode.trim() as OcrMode))) {
    return NextResponse.json({ error: "ocr_mode 必须是受支持的 OCR 模式字符串" }, { status: 400 });
  }
  const parsedMaxOutputTokens = Object.hasOwn(o, "max_output_tokens")
    ? parseMaxOutputTokens(o.max_output_tokens)
    : undefined;
  if (Object.hasOwn(o, "max_output_tokens")) {
    if (parsedMaxOutputTokens === null) {
      return NextResponse.json({ error: "最大输出 token 限制必须为正整数" }, { status: 400 });
    }
  }
  const saved = readSettings({
    api_key: typeof o.api_key === "string" ? o.api_key.trim() : undefined,
    proxy_password: typeof o.proxy_password === "string" ? o.proxy_password.trim() : undefined,
  });
  const values = {} as SettingsPayload;
  for (const f of SETTINGS_FIELDS) {
    const isProxyField = f === "proxy_url" || f === "proxy_username" || f === "proxy_password";
    if (f === "max_output_tokens") {
      values[f] = parsedMaxOutputTokens !== undefined
        ? String(parsedMaxOutputTokens)
        : (saved[f] ?? "8192");
    } else {
      values[f] = typeof o[f] === "string"
        ? (o[f] as string).trim()
        : isProxyField ? (saved[f] ?? "") : "";
    }
  }
  if (Object.hasOwn(o, "proxy_enabled") && typeof o.proxy_enabled !== "boolean") {
    return NextResponse.json({ error: "proxy_enabled 必须是布尔值" }, { status: 400 });
  }
  values.proxy_enabled = typeof o.proxy_enabled === "boolean" ? o.proxy_enabled : Boolean(saved.proxy_enabled);
  let incomingBaseUrl: URL;
  let savedTarget = "";
  try {
    incomingBaseUrl = parseHttpBaseUrl(values.base_url);
    if (saved.base_url) savedTarget = parseHttpBaseUrl(saved.base_url).href.replace(/\/+$/u, "");
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Base URL 必须是有效的 HTTP 或 HTTPS 地址",
    }, { status: 400 });
  }
  const targetChanged = Boolean(savedTarget) && incomingBaseUrl.href.replace(/\/+$/u, "") !== savedTarget;
  if (targetChanged && (!values.api_key || values.api_key.startsWith(API_KEY_MASK_PREFIX))) {
    return NextResponse.json({ error: "更换 Base URL 时必须重新填写 API Key" }, { status: 400 });
  }
  values.api_key = resolveIncomingApiKey(values.api_key, saved.api_key);
  values.proxy_password = resolveIncomingProxyPassword(values.proxy_password ?? "", saved.proxy_password ?? "");
  if (values.proxy_enabled || values.proxy_url) {
    try {
      const normalized = normalizeProxyConfig({
        enabled: values.proxy_enabled,
        url: values.proxy_url,
        username: values.proxy_username,
        password: values.proxy_password,
      });
      values.proxy_url = normalized.url;
      values.proxy_username = normalized.username;
      values.proxy_password = normalized.password;
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "代理配置无效",
      }, { status: 400 });
    }
  }
  writeSettings(values);
  const updated = readSettings();
  return NextResponse.json({
    ...updated,
    api_key: maskApiKey(updated.api_key),
    proxy_password: maskProxyPassword(updated.proxy_password ?? ""),
    baseUrlWarning: describePrivateBaseUrl(incomingBaseUrl),
  });
}

async function handleSettingsRequest(req: Request, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (!(error instanceof SettingsSecretError)) throw error;
    const requestId = logServerError(`${req.method} /api/settings`, error, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json({ error: error.message, requestId }, { status: 500 });
  }
}

export const GET = withRouteErrorHandling("GET /api/settings", (req) => handleSettingsRequest(req, handleGet));
export const PUT = withRouteErrorHandling("PUT /api/settings", (req) => handleSettingsRequest(req, () => handlePut(req)));
