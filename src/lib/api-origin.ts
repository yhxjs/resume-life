import { logServerEvent } from "./server-errors";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 已告警过的原始条目，避免每个请求都重复刷同一条 warn */
const warnedHostEntries = new Set<string>();

export type MutationOriginResult =
  | { ok: true }
  | { ok: false; status: 403 };

/** 从 Host 头解析主机名（去端口、保留 IPv6 方括号形式）；无法解析时返回 null */
function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 归一化一条白名单配置：容忍按反向代理文档的习惯写成 URL 或带端口。
 *
 * 不能把条目直接交给 hostnameOf：`new URL("http://https://a.example.com")` 会把
 * 协议当成主机，解析出主机名 `https`——白名单里于是多出一个永不匹配的条目，
 * 现象是「域名明明配了还是全站 403」，与「忘记配置」完全无法区分。
 */
function normalizeAllowedHost(entry: string): string | null {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed === "") return null;
  return hostnameOf(trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""));
}

/**
 * 反向代理部署时显式允许的对外主机名（逗号分隔），默认只允许本机回环地址。
 * 只认请求真正打到的 Host 头：x-forwarded-host 由客户端可写，不能作为放行依据。
 */
function allowedHostnames(): Set<string> {
  const configured = new Set<string>();
  for (const entry of (process.env.RESUME_LIFE_ALLOWED_HOSTS ?? "").split(",")) {
    const hostname = normalizeAllowedHost(entry);
    if (hostname) {
      configured.add(hostname);
      continue;
    }
    // 无法解析成主机名的条目直接丢弃，而不是原样塞进白名单：
    // 留着既不匹配任何请求，又让「配了却不生效」更难排查。
    if (entry.trim() !== "" && !warnedHostEntries.has(entry)) {
      warnedHostEntries.add(entry);
      logServerEvent("warn", "origin.allowedHosts", {
        context: { resource: "invalid-host-entry" },
      });
    }
  }
  return new Set([...LOOPBACK_HOSTNAMES, ...configured]);
}

/**
 * 请求目标白名单 + 变更请求同源校验。
 * DNS rebinding 会让恶意页面的 Origin 与 Host 天然相等，仅比较二者无法防护；
 * 因此先要求请求打到的 Host 属于白名单（回环地址或显式配置），读请求同样适用，
 * 避免 GET 被用来读取本机简历、JD 等隐私数据。
 */
export function validateMutationOrigin(request: Request): MutationOriginResult {
  const host = request.headers.get("host") || new URL(request.url).host;
  const hostname = hostnameOf(host);
  if (hostname === null || !allowedHostnames().has(hostname)) {
    return { ok: false, status: 403 };
  }

  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const origin = request.headers.get("origin");
  if (origin === null) return { ok: true };

  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
      ? { ok: true }
      : { ok: false, status: 403 };
  } catch {
    return { ok: false, status: 403 };
  }
}
