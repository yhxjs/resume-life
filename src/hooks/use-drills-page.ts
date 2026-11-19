"use client";

import { useEffect, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useDrillDeletion } from "@/hooks/use-drill-deletion";
import { errorMessage } from "@/lib/error-message";
import type { DrillItem } from "@/lib/drill-history";
export type { DrillItem } from "@/lib/drill-history";

export type ProjectBrief = { id: number; name: string };
export type DirectionStat = { direction: string; count: number };

export function useDrillsPage() {
  const [projects, setProjects] = useState<ProjectBrief[] | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [directions, setDirections] = useState<DirectionStat[] | null>(null);
  const [directionsError, setDirectionsError] = useState("");
  const [directionsReloadVersion, setDirectionsReloadVersion] = useState(0);
  const [projectId, setProjectId] = useState<number | "">("");
  const [filterProject, setFilterProject] = useState<number | "">("");
  const [keyword, setKeyword] = useState("");
  const [projectsReloadVersion, setProjectsReloadVersion] = useState(0);

  const {
    items: storedDrills,
    nextCursor,
    loadingMore,
    listError,
    failedCursor,
    loadMore,
    reload: reloadList,
  } = useCursorList<DrillItem>({
    queryKey: `drills:${filterProject}:${keyword.trim()}`,
    delay: 250,
    buildUrl: (cursor) => {
      const params = new URLSearchParams();
      if (filterProject !== "") params.set("project_id", String(filterProject));
      if (keyword.trim()) params.set("q", keyword.trim());
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString();
      return `/api/drills${qs ? `?${qs}` : ""}`;
    },
  });
  const deletion = useDrillDeletion(reloadList);
  const drills = storedDrills?.filter(drill => !deletion.deletedIds.has(drill.id)) ?? null;

  /** DrillHistory 仍按 (cursor?) 调用：无参=重取首页，带游标=续页 */
  function loadDrills(cursor?: string) {
    if (cursor === undefined) reloadList();
    else loadMore();
  }

  useEffect(() => {
    let cancelled = false;
    jsonFetch<ProjectBrief[]>("/api/projects")
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setProjectsError("");
        if (list.length > 0) setProjectId(list[0]!.id);
      })
      .catch((err) => {
        if (cancelled) return;
        setProjectsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectsReloadVersion]);

  // 方向统计只影响筛选项，失败时给出提示与重试，避免筛选器静默为空
  useEffect(() => {
    let cancelled = false;
    jsonFetch<DirectionStat[]>("/api/bank/directions")
      .then((list) => {
        if (cancelled) return;
        setDirections(list);
        setDirectionsError("");
      })
      .catch((err) => {
        if (cancelled) return;
        setDirectionsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [directionsReloadVersion]);

  const loadError = listError;

  return {
    projects,
    projectsError,
    reloadProjects: () => { setProjectsError(""); setProjectsReloadVersion((version) => version + 1); },
    directions,
    drills,
    nextCursor,
    loadingMore,
    loadError,
    directionsError,
    reloadDirections: () => setDirectionsReloadVersion((version) => version + 1),
    failedCursor,
    projectId,
    setProjectId,
    filterProject,
    setFilterProject,
    keyword,
    setKeyword,
    loadDrills,
    deletion,
    remove: deletion.remove,
  };
}
