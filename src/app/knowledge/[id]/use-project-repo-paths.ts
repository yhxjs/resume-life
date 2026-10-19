"use client";

import { useCallback, useEffect, useState } from "react";
import { loadStoredRepoPaths, saveStoredRepoPaths } from "@/lib/project-repo-paths-storage";
export { PROJECT_REPO_PATHS_KEY_PREFIX, getProjectRepoPathsStorageKey, loadStoredRepoPaths, saveStoredRepoPaths } from "@/lib/project-repo-paths-storage";

export function useProjectRepoPaths(projectId: number | string) {
  const [repoPaths, setRepoPathsInternal] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    const initial = loadStoredRepoPaths(projectId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage 属外部系统：SSR 首帧必须为空避免 hydration 错位，挂载后一次性回填
    setRepoPathsInternal(initial);
    setLoaded(true);
  }, [projectId]);

  const updatePaths = useCallback(
    (updater: string[] | ((prev: string[]) => string[])) => {
      setRepoPathsInternal((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        const cleaned = Array.from(
          new Set(
            next
              .map((p) => (typeof p === "string" ? p.trim() : ""))
              .filter((p) => p.length > 0)
          )
        );
        saveStoredRepoPaths(projectId, cleaned);
        return cleaned;
      });
    },
    [projectId]
  );

  const addPath = useCallback(
    (pathToAdd: string): boolean => {
      const target = pathToAdd.trim();
      if (!target) return false;
      let added = false;
      setRepoPathsInternal((prev) => {
        if (prev.includes(target)) {
          return prev;
        }
        added = true;
        const next = [...prev, target];
        saveStoredRepoPaths(projectId, next);
        return next;
      });
      return added;
    },
    [projectId]
  );

  const removePath = useCallback(
    (target: number | string) => {
      setRepoPathsInternal((prev) => {
        const next =
          typeof target === "number"
            ? prev.filter((_, i) => i !== target)
            : prev.filter((p) => p !== target);
        saveStoredRepoPaths(projectId, next);
        return next;
      });
    },
    [projectId]
  );

  const clearPaths = useCallback(() => {
    setRepoPathsInternal([]);
    saveStoredRepoPaths(projectId, []);
  }, [projectId]);

  return {
    repoPaths,
    loaded,
    setRepoPaths: updatePaths,
    addPath,
    removePath,
    clearPaths,
  };
}
