"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { type PersonaStyle, type PresetRemedy, type ScenarioType } from "@/lib/career-gap-remedy";
import { filterPresets, type PresetTab, type RemedyRecord } from "./gap-helpers";
import { errorMessage } from "@/lib/error-message";
import { useCursorList } from "@/hooks/use-cursor-list";

export function useGapRemedies() {
  const router = useRouter();
  const { items: records, total, nextCursor, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<RemedyRecord>({
    queryKey: "career-gap-remedies",
    buildUrl: (cursor) => `/api/tools/career-gap-remedies?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const [scenarioType, setScenarioType] = useState<ScenarioType>("both");
  const [rawStory, setRawStory] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [personaStyle, setPersonaStyle] = useState<PersonaStyle>("pragmatic");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [presetTab, setPresetTab] = useState<PresetTab>("all");
  const [inspectPreset, setInspectPreset] = useState<PresetRemedy | null>(null);
  const [copiedText, setCopiedText] = useState("");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  async function handleGenerate() {
    if (!rawStory.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const data = await jsonFetch<{ id: number }>("/api/tools/career-gap-remedies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioType, rawStory: rawStory.trim(), targetRole: targetRole.trim(), personaStyle }),
      });
      router.push(`/tools/gap/${data.id}`);
    } catch (reason) {
      setError(errorMessage(reason));
      setSubmitting(false);
    }
  }

  async function removeRecord(id: number) {
    if (!(await confirmDialog({ title: "删除重塑记录", message: "确定删除这份高情商重塑对策报告？", danger: true }))) return;
    try {
      await jsonFetch(`/api/tools/career-gap-remedies/${id}`, { method: "DELETE" });
      reload();
    } catch (reason) {
      await alertDialog({ title: "删除失败", message: errorMessage(reason) });
    }
  }

  async function copyScript(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(text);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedText(""), 2000);
    } catch {
      setError("复制失败，请检查浏览器剪贴板权限");
    }
  }

  const filteredPresets = useMemo(() => filterPresets(presetTab), [presetTab]);

  function usePreset(preset: PresetRemedy) {
    setRawStory(preset.rawPain);
    setScenarioType(preset.category);
  }

  return {
    records,
    total,
    nextCursor,
    loadingMore,
    failedCursor,
    loadMore,
    reload,
    loadError,
    scenarioType,
    rawStory,
    targetRole,
    personaStyle,
    submitting,
    error,
    presetTab,
    inspectPreset,
    copiedText,
    filteredPresets,
    setScenarioType,
    setRawStory,
    setTargetRole,
    setPersonaStyle,
    setPresetTab,
    setInspectPreset,
    handleGenerate,
    removeRecord,
    copyScript,
    usePreset,
  };
}
