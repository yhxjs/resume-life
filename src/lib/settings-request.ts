import { validateMutationOrigin } from "./api-origin";
import { API_KEY_MASK_PREFIX, readSettings, type ApiFormat } from "./settings";
import { VALID_API_FORMATS } from "./settings-constants";
import { parseHttpBaseUrl } from "./model-base-url";
export { parseHttpBaseUrl } from "./model-base-url";
import {
  normalizeProxyConfig,
  resolveIncomingProxyPassword,
  type ProxyConfig,
} from "./proxy-config";

/** 浏览器可触发的设置写入口只接受同源 JSON；无 Origin 的本地脚本仍可使用。 */
export function assertTrustedSettingsRequest(request: Request): void {
  if (!validateMutationOrigin(request).ok) throw new Error("拒绝跨站设置请求");
}

function normalizedTarget(value: string): string {
  const url = parseHttpBaseUrl(value);
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/+$/u, "");
}

const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan"];

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host.includes(":")) {
    // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
    return /^f[cd][0-9a-f]{2}:/u.test(host) || /^fe[89ab][0-9a-f]:/u.test(host);
  }
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) return false;
  const [a, b] = octets.map(Number) as [number, number];
  if (a > 255 || b > 255) return false;
  return a === 127 || a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

/**
 * 目标落在回环/内网/链路本地时给出提示。
 * 这是提示而非拦截：把模型跑在本机或内网（Ollama、局域网网关）是合法且常见的用法，
 * 但用户需要知道简历、JD 与作答内容会被发往该地址。
 */
export function describePrivateBaseUrl(url: URL): string | null {
  return isPrivateHost(url.hostname)
    ? "Base URL 指向本机或内网地址：简历、JD 与作答内容会发送到该地址，请确认它是你自己部署且可信的服务。"
    : null;
}

/** 两个配置探测入口共用字段与目标校验；请求体由 API 边界负责有界解析。 */
export function readModelSettingsRequest(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  const fields: Record<string, string> = {};
  for (const key of ["base_url", "api_key", "api_format", "model", "proxy_url", "proxy_username", "proxy_password"]) {
    if (!Object.hasOwn(body, key)) continue;
    const value: unknown = (body as Record<string, unknown>)[key];
    if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
    fields[key] = value;
  }
  let proxyEnabled: boolean | undefined;
  if (Object.hasOwn(body, "proxy_enabled")) {
    const value = (body as Record<string, unknown>).proxy_enabled;
    if (typeof value !== "boolean") throw new Error("proxy_enabled 必须是布尔值");
    proxyEnabled = value;
  }
  if (fields.api_format && !VALID_API_FORMATS.has(fields.api_format as ApiFormat)) {
    throw new Error("api_format 不受支持");
  }
  const saved = readSettings();
  const baseUrl = (fields.base_url || saved.base_url).trim();
  const incomingKey = (fields.api_key || "").trim();
  const changedTarget = Boolean(fields.base_url && saved.base_url) && normalizedTarget(baseUrl) !== normalizedTarget(saved.base_url);
  if (changedTarget && (!incomingKey || incomingKey.startsWith(API_KEY_MASK_PREFIX))) {
    throw new Error("更换 Base URL 时必须重新填写 API Key");
  }
  const apiKey = (incomingKey && !incomingKey.startsWith(API_KEY_MASK_PREFIX) ? incomingKey : saved.api_key).trim();
  if (!baseUrl || !apiKey) throw new Error("请先填写 Base URL 和 API Key");
  parseHttpBaseUrl(baseUrl);
  const format = (fields.api_format || saved.api_format || "openai_chat") as ApiFormat;
  const model = (fields.model || "").trim() || saved.model_parse || saved.model_summary || saved.model_question || saved.model_evaluate;
  const proxy: ProxyConfig = normalizeProxyConfig({
    enabled: proxyEnabled ?? Boolean(saved.proxy_enabled),
    url: fields.proxy_url ?? saved.proxy_url ?? "",
    username: fields.proxy_username ?? saved.proxy_username ?? "",
    password: resolveIncomingProxyPassword(fields.proxy_password ?? "", saved.proxy_password ?? ""),
  });
  return { baseUrl, apiKey, format, model, proxy };
}
