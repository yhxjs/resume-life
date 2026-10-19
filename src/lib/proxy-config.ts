/** Supported proxy protocols for model related requests. */
export type ProxyProtocol = "http" | "https" | "socks5";

export type ProxyConfig = {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
};

export type ProxyCandidate = {
  url: string;
  protocol: ProxyProtocol;
  source: "environment" | "windows" | "localhost";
  username?: string;
};

export const PROXY_PASSWORD_MASK_PREFIX = "•••proxy:";
export const PROXY_PROTOCOLS = new Set<ProxyProtocol>(["http", "https", "socks5"]);

function defaultPort(protocol: ProxyProtocol): number {
  if (protocol === "https") return 443;
  if (protocol === "socks5") return 1080;
  return 80;
}

function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse and validate a proxy URL without exposing its credentials. */
export function parseProxyUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("代理地址必须是有效的 URL");
  }
  const protocol = url.protocol.slice(0, -1).toLowerCase() as ProxyProtocol;
  if (!PROXY_PROTOCOLS.has(protocol)) {
    throw new Error("代理地址必须使用 HTTP、HTTPS 或 SOCKS5 协议");
  }
  if (!url.hostname) throw new Error("代理地址缺少主机名");
  for (const encoded of [url.username, url.password]) {
    try { decodeURIComponent(encoded); }
    catch { throw new Error("代理认证信息编码无效"); }
  }
  const port = Number(url.port || defaultPort(protocol));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("代理端口必须是 1 到 65535 之间的整数");
  }
  return url;
}

/** Return the effective port of a validated URL. */
export function proxyUrlPort(url: URL): number {
  const protocol = url.protocol.slice(0, -1).toLowerCase() as ProxyProtocol;
  return Number(url.port || defaultPort(protocol));
}

/**
 * Normalize the form/database representation used by all proxy callers.
 * Userinfo is removed from the URL and retained in the dedicated fields.
 */
export function normalizeProxyConfig(input: Partial<ProxyConfig>): ProxyConfig {
  const enabled = Boolean(input.enabled);
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  const usernameInput = typeof input.username === "string" ? input.username : "";
  const passwordInput = typeof input.password === "string" ? input.password : "";

  if (!rawUrl) {
    if (enabled) throw new Error("启用代理时必须填写代理地址");
    return { enabled, url: "", username: usernameInput, password: passwordInput };
  }

  let parsed: URL;
  try {
    parsed = parseProxyUrl(rawUrl);
  } catch (error) {
    // A disabled form is allowed to retain an incomplete value for later
    // editing. Strip obvious URL userinfo before retaining it so a malformed
    // pasted URL cannot expose its password through the settings response.
    if (!enabled) {
      const withoutUserInfo = rawUrl.replace(/^((?:[a-z][a-z\d+.-]*:\/\/)?)[^/]*@/iu, "$1");
      return { enabled: false, url: withoutUserInfo, username: usernameInput, password: passwordInput };
    }
    throw error;
  }
  const urlUsername = decodeUserInfo(parsed.username);
  const urlPassword = decodeUserInfo(parsed.password);
  const hasUsername = Object.hasOwn(input, "username");
  const hasPassword = Object.hasOwn(input, "password");
  // Empty form fields are treated as absent when the URL carries userinfo.
  // This lets pasted `http://user:pass@host` values retain their credentials
  // while still allowing callers that omit the fields to use URL userinfo.
  const username = hasUsername && usernameInput ? usernameInput : urlUsername || usernameInput;
  const password = hasPassword && passwordInput ? passwordInput : urlPassword || passwordInput;

  // Proxy endpoints do not use a path/query. Using origin also canonicalizes
  // protocol/hostname casing and removes a trailing slash and URL userinfo.
  const endpoint = `${parsed.protocol}//${parsed.host}`;
  return { enabled, url: endpoint.replace(/\/+$/u, ""), username, password };
}

export function maskProxyPassword(password: string): string {
  return password ? `${PROXY_PASSWORD_MASK_PREFIX}${password.slice(-4)}` : "";
}

export function resolveIncomingProxyPassword(incoming: string, saved: string): string {
  return incoming.startsWith(PROXY_PASSWORD_MASK_PREFIX) ? saved : incoming;
}

/** Convert a settings row into a proxy config while tolerating old mocks/rows. */
export function proxyConfigFromSettings(row: unknown): ProxyConfig {
  const value = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  return {
    enabled: value.proxy_enabled === true || value.proxy_enabled === 1 || value.proxy_enabled === "1",
    url: typeof value.proxy_url === "string" ? value.proxy_url : "",
    username: typeof value.proxy_username === "string" ? value.proxy_username : "",
    password: typeof value.proxy_password === "string" ? value.proxy_password : "",
  };
}
