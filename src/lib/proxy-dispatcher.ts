import { socksDispatcher } from "fetch-socks";
import { Dispatcher, ProxyAgent } from "undici";
import { normalizeProxyConfig, parseProxyUrl, proxyUrlPort, type ProxyConfig } from "./proxy-config";

let cachedKey: string | undefined;
let cachedDispatcher: Dispatcher | undefined;

function cacheKey(config: ProxyConfig): string {
  return [config.enabled ? "1" : "0", config.url, config.username, config.password].join("|");
}

function closeDispatcher(dispatcher: Dispatcher | undefined): void {
  if (!dispatcher) return;
  void dispatcher.close().catch(() => undefined);
}

/**
 * Return a process-local dispatcher for the normalized proxy configuration.
 * A single dispatcher is shared until any setting changes, then its pool is
 * closed before the replacement is used.
 */
export function getProxyDispatcher(config: ProxyConfig): Dispatcher | undefined {
  if (!config.enabled) {
    closeProxyDispatcher();
    return undefined;
  }
  const normalized = normalizeProxyConfig(config);
  if (!normalized.enabled || !normalized.url) {
    if (cachedDispatcher) closeDispatcher(cachedDispatcher);
    cachedDispatcher = undefined;
    cachedKey = undefined;
    return undefined;
  }

  const key = cacheKey(normalized);
  if (cachedDispatcher && cachedKey === key) return cachedDispatcher;

  let next: Dispatcher;
  try {
    const parsed = parseProxyUrl(normalized.url);
    if (parsed.protocol === "socks5:") {
      next = socksDispatcher({
        type: 5,
        host: parsed.hostname.replace(/^\[|\]$/gu, ""),
        port: proxyUrlPort(parsed),
        ...(normalized.username ? { userId: normalized.username } : {}),
        ...(normalized.password ? { password: normalized.password } : {}),
      });
    } else {
      const token = normalized.username || normalized.password
        ? `Basic ${Buffer.from(`${normalized.username}:${normalized.password}`, "utf8").toString("base64")}`
        : undefined;
      next = new ProxyAgent({
        uri: parsed.origin,
        ...(token ? { token } : {}),
      });
    }
  } catch (error) {
    throw new Error(`代理配置无效：${error instanceof Error ? error.message : "无法创建请求分发器"}`);
  }

  const previous = cachedDispatcher;
  cachedDispatcher = next;
  cachedKey = key;
  if (previous) closeDispatcher(previous);
  return next;
}

/** Close and forget the currently cached dispatcher. */
export function closeProxyDispatcher(): void {
  const previous = cachedDispatcher;
  cachedDispatcher = undefined;
  cachedKey = undefined;
  closeDispatcher(previous);
}

/** Fetch options to merge into model-related requests. */
export function proxyFetchInit(config: ProxyConfig): { dispatcher?: Dispatcher } {
  const dispatcher = getProxyDispatcher(config);
  return dispatcher ? { dispatcher } : {};
}
