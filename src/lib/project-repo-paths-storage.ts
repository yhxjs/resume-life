import { documentDataGeneration } from "./api-fetch";

export const PROJECT_REPO_PATHS_KEY_PREFIX = "resume_life_project_repo_paths_";

export function getProjectRepoPathsStorageKey(projectId: number | string): string | null {
  const generation = documentDataGeneration();
  return generation ? `${PROJECT_REPO_PATHS_KEY_PREFIX}${generation}:${projectId}` : null;
}

export function loadStoredRepoPaths(projectId: number | string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const key = getProjectRepoPathsStorageKey(projectId);
    if (!key) return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cleaned = parsed
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter((p) => p.length > 0);
    return Array.from(new Set(cleaned));
  } catch {
    return [];
  }
}

export function saveStoredRepoPaths(projectId: number | string, paths: string[]): void {
  if (typeof window === "undefined") return;
  try {
    const key = getProjectRepoPathsStorageKey(projectId);
    if (!key) return;
    const cleaned = Array.from(
      new Set(paths.map((p) => (typeof p === "string" ? p.trim() : "")).filter((p) => p.length > 0))
    );
    if (cleaned.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(cleaned));
  } catch {}
}

/** 清理全部数据世代的源码路径；失败交由清理入口展示。 */
export function clearStoredRepoPaths(): void {
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(PROJECT_REPO_PATHS_KEY_PREFIX)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}
