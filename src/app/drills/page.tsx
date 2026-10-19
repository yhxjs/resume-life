"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DrillStartForm,
  type DrillMode,
} from "@/components/drills/drill-start-form";
import { DrillHistory } from "@/components/drills/drill-history";
import { useDrillsPage } from "@/hooks/use-drills-page";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";

export default function DrillsPage() {
  const router = useRouter();
  const {
    projects,
    projectsError,
    reloadProjects,
    directions,
    directionsError,
    reloadDirections,
    drills,
    nextCursor,
    loadingMore,
    loadError,
    failedCursor,
    projectId,
    setProjectId,
    filterProject,
    setFilterProject,
    keyword,
    setKeyword,
    loadDrills,
    remove,
  } = useDrillsPage();
  const [mode, setMode] = useState<DrillMode>("project");
  const [bankDirection, setBankDirection] = useState("");
  const [bankJd, setBankJd] = useState("");
  const [count, setCount] = useState(5);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setStarting(true);
    setError("");
    try {
      const payload = mode === "project"
        ? { source: "project", project_id: projectId, count }
        : { source: "bank", direction: bankDirection.trim(), jd: bankJd.trim(), count };
      const data = await jsonFetch<{ id: number }>("/api/drills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      router.push(`/drills/${data.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setStarting(false);
    }
  }

  function changeMode(nextMode: DrillMode) {
    setMode(nextMode);
    setError("");
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">专项题目练习</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            项目深挖题基于真实项目文档出题；岗位通用题按 JD 或技术方向出八股与行为考题。逐题即时四维小分批阅。
          </p>
        </div>
        {drills !== null && (
          <div className="text-xs text-muted">
            已完成精练：<strong className="font-mono text-ink font-bold text-sm">{drills.length}</strong> 场
          </div>
        )}
      </div>

      <DrillStartForm
        mode={mode}
        projects={projects}
        projectsError={projectsError}
        onRetryProjects={reloadProjects}
        directions={directions}
        directionsError={directionsError}
        projectId={projectId}
        bankDirection={bankDirection}
        bankJd={bankJd}
        count={count}
        starting={starting}
        error={error}
        onModeChange={changeMode}
        onProjectIdChange={setProjectId}
        onBankDirectionChange={setBankDirection}
        onBankJdChange={setBankJd}
        onCountChange={setCount}
        onStart={start}
        onRetryDirections={reloadDirections}
      />

      <DrillHistory
        projects={projects}
        drills={drills}
        nextCursor={nextCursor}
        loadingMore={loadingMore}
        loadError={loadError}
        failedCursor={failedCursor}
        filterProject={filterProject}
        keyword={keyword}
        onFilterProjectChange={setFilterProject}
        onKeywordChange={setKeyword}
        onLoad={loadDrills}
        onRemove={remove}
      />
    </div>
  );
}
