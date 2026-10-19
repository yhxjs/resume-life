import { DATA_GENERATION_HEADER, DATA_GENERATION_META } from "./data-generation-contract";

const generations = new WeakMap<Document, string>();

/** 世代属于当前文档；后台响应或 SPA 刷新不能替旧页面采用恢复后的身份。 */
export function documentDataGeneration(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const generation = generations.get(document)
    ?? document.querySelector<HTMLMetaElement>(`meta[name="${DATA_GENERATION_META}"]`)?.content;
  if (generation) generations.set(document, generation);
  return generation;
}

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!url.startsWith("/api/") || url.startsWith("/api/auth/")) return fetch(url, init);
  const generation = documentDataGeneration();
  if (!generation) return fetch(url, init);
  const headers = new Headers(init?.headers);
  headers.set(DATA_GENERATION_HEADER, generation);
  return fetch(url, { ...init, headers });
}
