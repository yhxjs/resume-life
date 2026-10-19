/** 全站统一的 JSON fetch 包装：非 2xx 或网络失败都抛出可读错误，调用方只需 catch 展示 */
import { apiFetch } from "./api-fetch";

const AUTH_API_PREFIX = "/api/auth/";

/** 会话失效时的全局兜底：跳去登录页并带上回跳地址；鉴权端点自身除外（避免死循环） */
function redirectIfSessionExpired(url: string, status: number): void {
  if (status !== 401 || url.startsWith(AUTH_API_PREFIX)) return;
  if (typeof window === "undefined") return;
  const current = `${window.location.pathname}${window.location.search}`;
  if (window.location.pathname === "/login") return;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 会话过期需要整页刷新来丢弃所有已挂载页面的客户端状态，SPA 过渡做不到
  window.location.assign(`/login?next=${encodeURIComponent(current)}`);
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    res = await apiFetch(url, {
      ...init,
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("无法连接服务器：应用可能正在重启，请稍等几秒后重试");
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!res.ok) {
    redirectIfSessionExpired(url, res.status);
    const error = body?.error;
    const message = typeof error === "string" && error.trim() ? error : `HTTP ${res.status}`;
    throw new HttpError(message, res.status);
  }
  if (body === null) throw new Error("服务器返回的数据无法读取，请重试");
  return body as T;
}

export { jsonFetch };
