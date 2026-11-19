"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { jsonFetch } from "@/lib/fetcher";
import { type PersonaStyle, type PresetRemedy, type ScenarioType } from "@/lib/career-gap-remedy";
import { filterPresets, remedyTitle, type PresetTab, type RemedyRecord } from "./gap-helpers";
import { errorMessage } from "@/lib/error-message";
import { useCursorList } from "@/hooks/use-cursor-list";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useToolHistoryDeletion } from "@/hooks/use-tool-history-deletion";

export function useGapRemedies() {
  const router = useRouter();
  const { items: records, total, nextCursor, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<RemedyRecord>({
    queryKey: "career-gap-remedies",
    buildUrl: (cursor) => `/api/tools/career-gap-remedies?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const deletion = useToolHistoryDeletion("career-gap-remedies", reload);
  const visibleRecords = records?.filter(record => !deletion.deletedIds.has(record.id)) ?? null;
  const [scenarioType, updateScenarioType] = useState<ScenarioType>("both");
  const [rawStory, updateRawStory] = useState("");
  const [targetRole, updateTargetRole] = useState("");
  const [personaStyle, updatePersonaStyle] = useState<PersonaStyle>("pragmatic");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [presetTab, setPresetTab] = useState<PresetTab>("all");
  const [inspectPreset, setInspectPreset] = useState<PresetRemedy | null>(null);
  const { copiedText, copyError, copying, copy: copyScript } = useCopyFeedback();
  const mounted = useRef(false);
  const generation = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current?.abort(); generation.current = null; };
  }, []);

  const canEdit = () => mounted.current && generation.current === null;
  const setScenarioType = (value: ScenarioType) => { if (canEdit()) updateScenarioType(value); };
  const setRawStory = (value: string) => { if (canEdit()) updateRawStory(value); };
  const setTargetRole = (value: string) => { if (canEdit()) updateTargetRole(value); };
  const setPersonaStyle = (value: PersonaStyle) => { if (canEdit()) updatePersonaStyle(value); };

  async function handleGenerate() {
    if (!canEdit() || !deletion.canStart() || !rawStory.trim()) return;
    const controller = new AbortController();
    generation.current = controller;
    const isCurrent = () => mounted.current && generation.current === controller && !controller.signal.aborted;
    setSubmitting(true);
    setError("");
    try {
      const data = await jsonFetch<unknown>("/api/tools/career-gap-remedies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioType, rawStory: rawStory.trim(), targetRole: targetRole.trim(), personaStyle }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const id = data && typeof data === "object" && !Array.isArray(data) ? (data as { id?: unknown }).id : undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("生成响应不完整");
      router.push(`/tools/gap/${id}`);
    } catch (reason) {
      if (!isCurrent()) return;
      generation.current = null;
      setError(`${errorMessage(reason)}。原始材料已保留，结果仍可能已经保存，请先核对历史记录再决定是否重试；不会自动再次生成。`);
      setSubmitting(false);
      reload();
    }
  }

  async function removeRecord(id: number) {
    if (!canEdit()) return;
    const record = records?.find(record => record.id === id);
    await deletion.remove(id, record ? remedyTitle(record) : "空窗沟通报告");
  }

  const filteredPresets = useMemo(() => filterPresets(presetTab), [presetTab]);

  function usePreset(preset: PresetRemedy) {
    if (!canEdit()) return;
    setRawStory(preset.rawPain);
    setScenarioType(preset.category);
  }

  return {
    records: visibleRecords,
    deletion,
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
    copyError,
    copying,
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
