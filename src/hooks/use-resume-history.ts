"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModuleData } from "@/lib/modules";

export interface ResumeSnapshot {
  title: string;
  modules: ModuleData[];
}

interface UseResumeHistoryOptions {
  onRestore: (snapshot: ResumeSnapshot, diff: HistoryDiff) => void;
  maxHistory?: number;
  debounceMs?: number;
}

export interface HistoryDiff {
  titleChanged: boolean;
  changedModuleKeys: string[];
}

function cloneSnapshot(s: ResumeSnapshot): ResumeSnapshot {
  if (typeof structuredClone === "function") {
    return structuredClone(s);
  }
  return JSON.parse(JSON.stringify(s));
}

function computeDiff(prev: ResumeSnapshot, next: ResumeSnapshot): HistoryDiff {
  const titleChanged = prev.title !== next.title;
  const changedModuleKeys: string[] = [];

  const prevMap = new Map(prev.modules.map((m) => [m.key, m.content]));
  const nextMap = new Map(next.modules.map((m) => [m.key, m.content]));

  for (const [key, nextContent] of nextMap) {
    const prevContent = prevMap.get(key);
    if (JSON.stringify(prevContent) !== JSON.stringify(nextContent)) {
      changedModuleKeys.push(key);
    }
  }

  return { titleChanged, changedModuleKeys };
}

export function useResumeHistory({
  onRestore,
  maxHistory = 50,
  debounceMs = 700,
}: UseResumeHistoryOptions) {
  const pastRef = useRef<ResumeSnapshot[]>([]);
  const presentRef = useRef<ResumeSnapshot | null>(null);
  const futureRef = useRef<ResumeSnapshot[]>([]);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // 防抖入栈控制
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const baseSnapshotRef = useRef<ResumeSnapshot | null>(null);

  const updateState = useCallback(() => {
    setCanUndo(pastRef.current.length > 0 || baseSnapshotRef.current !== null);
    setCanRedo(futureRef.current.length > 0);
  }, []);

  const resetHistory = useCallback((initial: ResumeSnapshot) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    baseSnapshotRef.current = null;
    pastRef.current = [];
    futureRef.current = [];
    presentRef.current = cloneSnapshot(initial);
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  const flushPendingDebounce = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (baseSnapshotRef.current && presentRef.current) {
      pastRef.current.push(baseSnapshotRef.current);
      if (pastRef.current.length > maxHistory) {
        pastRef.current.shift();
      }
      baseSnapshotRef.current = null;
    }
  }, [maxHistory]);

  const recordChange = useCallback(
    (nextSnapshot: ResumeSnapshot, mode: "debounce" | "immediate" = "debounce") => {
      if (!presentRef.current) {
        presentRef.current = cloneSnapshot(nextSnapshot);
        return;
      }

      if (mode === "immediate") {
        flushPendingDebounce();
        pastRef.current.push(cloneSnapshot(presentRef.current));
        if (pastRef.current.length > maxHistory) {
          pastRef.current.shift();
        }
        presentRef.current = cloneSnapshot(nextSnapshot);
        futureRef.current = [];
        updateState();
      } else {
        if (!baseSnapshotRef.current) {
          baseSnapshotRef.current = cloneSnapshot(presentRef.current);
        }
        presentRef.current = cloneSnapshot(nextSnapshot);
        futureRef.current = [];
        updateState();

        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          flushPendingDebounce();
          updateState();
        }, debounceMs);
      }
    },
    [debounceMs, flushPendingDebounce, maxHistory, updateState]
  );

  const undo = useCallback(() => {
    flushPendingDebounce();

    if (pastRef.current.length === 0 || !presentRef.current) return;

    const previous = pastRef.current.pop()!;
    futureRef.current.push(cloneSnapshot(presentRef.current));

    const diff = computeDiff(presentRef.current, previous);
    presentRef.current = cloneSnapshot(previous);

    updateState();
    onRestore(previous, diff);
  }, [flushPendingDebounce, onRestore, updateState]);

  const redo = useCallback(() => {
    flushPendingDebounce();

    if (futureRef.current.length === 0 || !presentRef.current) return;

    const next = futureRef.current.pop()!;
    pastRef.current.push(cloneSnapshot(presentRef.current));
    if (pastRef.current.length > maxHistory) {
      pastRef.current.shift();
    }

    const diff = computeDiff(presentRef.current, next);
    presentRef.current = cloneSnapshot(next);

    updateState();
    onRestore(next, diff);
  }, [flushPendingDebounce, maxHistory, onRestore, updateState]);

  // 全局键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;

      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"]')) {
        return;
      }

      const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (!mod) return;

      const isZ = e.key === "z" || e.key === "Z";
      const isY = e.key === "y" || e.key === "Y";

      if (isZ && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((isZ && e.shiftKey) || (!isMac && isY && !e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [undo, redo]);

  return {
    canUndo,
    canRedo,
    undo,
    redo,
    recordChange,
    resetHistory,
    flushPendingDebounce,
  };
}
