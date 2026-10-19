"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type ModuleData, type ModuleKey } from "@/lib/modules";
import { isTemplateRef, type CustomTemplate, type ResumeStyleOverrides } from "@/lib/templates";
import type { ChangeOptions, Status } from "@/components/resume/module-editors";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { DiagnosisField } from "@/lib/diagnosis";
import { useResumeHistory, type HistoryDiff, type ResumeSnapshot } from "@/hooks/use-resume-history";
import { writeDescribableItem, writeDiagnosisValue } from "@/lib/module-descriptions";
import {
  getResumeSaveQueue,
  isAbortError,
  type ResumeDocument,
  type ResumeSaveQueue,
  type SavePhase,
} from "@/lib/resume-save-queue";
import { errorMessage } from "@/lib/error-message";
import { motionSafeScrollBehavior } from "@/lib/reduced-motion";

type ResumeData = {
  resume: { id: number; title: string; template: string; style_overrides?: ResumeStyleOverrides; styleCorrupted?: boolean; created_at: string; updated_at: string };
  modules: ModuleData[];
  warnings?: string[];
  addedKey?: string;
};

function shouldIgnoreMutationError(error: unknown, mounted: boolean) {
  return !mounted || isAbortError(error);
}

export function useResumeEditorController(id: string) {
  const [modules, setModules] = useState<ModuleData[] | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [template, setTemplate] = useState("classic");
  const [styleOverrides, setStyleOverrides] = useState<ResumeStyleOverrides>({});
  const [customs, setCustoms] = useState<CustomTemplate[]>([]);
  const [templateLoadError, setTemplateLoadError] = useState("");
  const [templateReloadVersion, setTemplateReloadVersion] = useState(0);
  const [activeKey, setActiveKey] = useState("");
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [styleCorrupted, setStyleCorrupted] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<"edit" | "preview">("edit");
  const [editLocateTarget, setEditLocateTarget] = useState<{
    key: string;
    entryIndex?: number;
    field?: string;
    timestamp: number;
  } | null>(null);
  const rightEditorContainerRef = useRef<HTMLDivElement>(null);

  const titleDraftRef = useRef(titleDraft);
  const modulesRef = useRef<ModuleData[] | null>(null);
  const savedOrderRef = useRef<string[]>([]);
  const savedTemplateRef = useRef("classic");
  const savedStyleOverridesRef = useRef<ResumeStyleOverrides>({});
  const orderMutationRef = useRef(0);
  const templateMutationRef = useRef(0);
  const styleMutationRef = useRef(0);
  const queueRef = useRef<ResumeSaveQueue | null>(null);
  const mountedRef = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const onRestore = useCallback((snapshot: ResumeSnapshot, diff: HistoryDiff) => {
    modulesRef.current = snapshot.modules;
    titleDraftRef.current = snapshot.title;
    setModules(snapshot.modules);
    setTitleDraft(snapshot.title);
    queueRef.current?.edit({
      ...(diff.titleChanged ? { title: snapshot.title } : {}),
      modules: Object.fromEntries(snapshot.modules
        .filter((module) => diff.changedModuleKeys.includes(module.key))
        .map((module) => [module.key, module.content])),
    });
  }, []);

  const { canUndo, canRedo, undo, redo, recordChange, resetHistory, flushPendingDebounce } =
    useResumeHistory({ onRestore });

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    const queue = getResumeSaveQueue(id);
    queueRef.current = queue;
    const unsubscribe = queue.subscribe((state) => {
      setStatus(state.status);
      setSaveError(state.error);
      setStorageError(state.storageError);
      setSavePhase(state.phase);
      setNextRetryAt(state.nextRetryAt);
    });
    const flush = () => { void queue.flush().catch(() => {}); };
    const retry = () => {
      if (queue.needsUnloadWarning) void queue.retry().catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("online", retry);
    queue.load(() => jsonFetch<ResumeData>(`/api/resumes/${id}`))
      .then((d) => {
        if (cancelled) return;
        modulesRef.current = d.modules;
        savedOrderRef.current = d.modules.map((module) => module.key);
        titleDraftRef.current = d.resume.title;
        setModules(d.modules);
        setTitleDraft(d.resume.title);
        resetHistory({ title: d.resume.title, modules: d.modules });
        setWarnings(d.warnings ?? []);
        setStyleCorrupted(Boolean(d.resume.styleCorrupted));
        setActiveKey(d.modules[0]?.key ?? "");
        const locate = new URLSearchParams(window.location.hash.slice(1));
        const requestedKey = locate.get("module");
        const targetModule = d.modules.find((module) => module.key === requestedKey);
        if (requestedKey === "__title__" || targetModule) {
          const rawIndex = locate.get("entry");
          const itemId = locate.get("item");
          const itemIndex = itemId && Array.isArray(targetModule?.content)
            ? targetModule.content.findIndex((item: { id?: string }) => item.id === itemId) : -1;
          const entryIndex = itemIndex >= 0 ? itemIndex : rawIndex !== null && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
          if (targetModule) setActiveKey(targetModule.key);
          setMobileTab("edit");
          setEditLocateTarget({ key: requestedKey!, entryIndex, field: locate.get("field") ?? undefined, timestamp: Date.now() });
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        } else if (requestedKey === "basic") {
          setAddOpen(true);
        }
        savedStyleOverridesRef.current = d.resume.style_overrides ?? {};
        setStyleOverrides(savedStyleOverridesRef.current);
        const saved = d.resume.template;
        savedTemplateRef.current = isTemplateRef(saved) ? saved : "classic";
        setTemplate(savedTemplateRef.current);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("online", retry);
      // 队列按简历 ID 在当前标签页共享；站内导航时保留自动保存，让卸载前的防抖草稿排空。
    };
  }, [id, resetHistory, loadAttempt]);

  // 自定义模板列表（下拉选项 + 样式解析），加载失败不阻塞编辑，但要在下拉旁提示并可重试
  useEffect(() => {
    let cancelled = false;
    jsonFetch<{ items: CustomTemplate[] }>("/api/templates")
      .then((d) => {
        if (cancelled) return;
        setCustoms(d.items);
        setTemplateLoadError("");
      })
      .catch((reason) => {
        if (!cancelled) setTemplateLoadError(errorMessage(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [templateReloadVersion]);

  const setDraft = useCallback(
    (key: string, content: unknown, opts?: ChangeOptions) => {
      if (!modulesRef.current) return;
      const next = modulesRef.current.map((m) => m.key === key ? { ...m, content } : m);
      modulesRef.current = next;
      queueRef.current?.edit({ modules: { [key]: content } });
      setModules(next);
      recordChange(
        { title: titleDraftRef.current, modules: next },
        opts?.immediate ? "immediate" : "debounce"
      );
    },
    [recordChange]
  );

  /** 模块级批量美化写入：逐条折叠出新 content，一次性提交 */
  const handleBeautifyApply = useCallback(
    (moduleKey: string, moduleType: "work" | "projects") =>
      (updates: { id: string; html: string }[]) => {
        const mod = modulesRef.current?.find((m) => m.key === moduleKey);
        if (!mod || updates.length === 0) return;
        let next = mod.content;
        for (const u of updates) {
          next = writeDescribableItem(moduleType, next, u.id, u.html);
        }
        setDraft(moduleKey, next, { immediate: true });
      },
    [setDraft]
  );

  const applyUpdated = useCallback((updated: ResumeDocument) => {
    if (!mountedRef.current) return;
    modulesRef.current = updated.modules;
    savedOrderRef.current = updated.modules.map((module) => module.key);
    setModules(updated.modules);
    resetHistory({ title: titleDraftRef.current, modules: updated.modules });
  }, [resetHistory]);

  async function addModule(label: string, type: ModuleKey) {
    try {
      const updated = await queueRef.current!.mutate({ addModule: { label, type } }, applyUpdated);
      if (!mountedRef.current) return;
      setAddOpen(false);
      if (updated.addedKey) setActiveKey(updated.addedKey);
    } catch (err) {
      if (shouldIgnoreMutationError(err, mountedRef.current)) return;
      throw err;
    }
  }

  async function removeModule(key: string) {
    const mod = modules?.find((m) => m.key === key);
    if (!modules || !mod) return;
    const idx = modules.findIndex((m) => m.key === key);
    const ok = await confirmDialog({
      title: "删除模块",
      message: `确定删除「${mod.label}」模块吗？该模块已填写的内容将一并删除。`,
      danger: true,
    });
    if (!ok) return;
    try {
      const updated = await queueRef.current!.mutate({ removeModule: key }, applyUpdated);
      const next = updated.modules;
      if (activeKey === key) {
        setActiveKey(next[Math.min(idx, next.length - 1)]?.key ?? "");
      }
    } catch (err) {
      if (shouldIgnoreMutationError(err, mountedRef.current)) return;
      await alertDialog({ title: "删除模块失败", message: errorMessage(err) });
    }
  }

  const renameModule = useCallback(
    async (key: string, label: string) => {
      try {
        await queueRef.current!.mutate({ renameModule: { key, label } }, applyUpdated);
      } catch (err) {
        if (shouldIgnoreMutationError(err, mountedRef.current)) return;
        await alertDialog({ title: "重命名失败", message: errorMessage(err) });
      }
    },
    [applyUpdated]
  );

  function moveModule(dragKey: string, toIndex: number) {
    const prev = modulesRef.current;
    if (!prev) return;
    const from = prev.findIndex((m) => m.key === dragKey);
    if (from < 0 || from === toIndex) return;
    const next = [...prev];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(toIndex, 0, moved);
    modulesRef.current = next;
    setModules(next);
  }

  async function commitOrder(orderedKeys: string[]) {
    const mutation = ++orderMutationRef.current;
    try {
      await queueRef.current!.mutate({ moduleOrder: orderedKeys }, (updated) => {
        savedOrderRef.current = updated.modules.map((module) => module.key);
        if (mutation === orderMutationRef.current) applyUpdated(updated);
      });
    } catch (err) {
      if (shouldIgnoreMutationError(err, mountedRef.current)) return;
      if (mutation === orderMutationRef.current && modulesRef.current) {
        const byKey = new Map(modulesRef.current.map((module) => [module.key, module]));
        const savedKeys = new Set(savedOrderRef.current);
        const restored = [
          ...savedOrderRef.current.flatMap((key) => {
            const mod = byKey.get(key);
            return mod ? [mod] : [];
          }),
          ...modulesRef.current.filter((modItem) => !savedKeys.has(modItem.key)),
        ];
        modulesRef.current = restored;
        setModules(restored);
      }
      await alertDialog({ title: "排序保存失败", message: errorMessage(err) });
    }
  }

  function handleTitleChange(val: string) {
    titleDraftRef.current = val;
    setTitleDraft(val);
    queueRef.current?.edit({ title: val });
    if (modulesRef.current) {
      recordChange({ title: val, modules: modulesRef.current }, "debounce");
    }
  }

  function saveTitle() {
    flushPendingDebounce();
    void queueRef.current?.flush().catch(() => {});
  }

  function retrySave() {
    void queueRef.current?.retry().catch(() => {});
  }

  function switchTemplate(ref: string) {
    const mutation = ++templateMutationRef.current;
    setTemplate(ref);
    queueRef.current!.mutate({ template: ref })
      .then((updated) => {
        if (!mountedRef.current) return;
        const saved = (updated as ResumeData).resume.template;
        savedTemplateRef.current = isTemplateRef(saved) ? saved : ref;
        if (mutation === templateMutationRef.current) setTemplate(savedTemplateRef.current);
      })
      .catch((err) => {
        if (shouldIgnoreMutationError(err, mountedRef.current)) return;
        if (mutation === templateMutationRef.current) setTemplate(savedTemplateRef.current);
        return alertDialog({ title: "模板保存失败", message: errorMessage(err) });
      });
  }

  function handleUpdateStyleOverrides(overrides: ResumeStyleOverrides | null) {
    const mutation = ++styleMutationRef.current;
    setStyleOverrides(overrides ?? {});
    queueRef.current?.mutate({ styleOverrides: overrides })
      .then((updated) => {
        if (!mountedRef.current) return;
        savedStyleOverridesRef.current = (updated as ResumeData).resume.style_overrides ?? {};
        if (mutation === styleMutationRef.current) {
          setStyleOverrides(savedStyleOverridesRef.current);
          setStyleCorrupted(Boolean((updated as ResumeData).resume.styleCorrupted));
          setWarnings((updated as ResumeData).warnings ?? []);
        }
      })
      .catch((err) => {
        if (shouldIgnoreMutationError(err, mountedRef.current)) return;
        if (mutation === styleMutationRef.current && !(err instanceof HttpError && err.status === 409)) setStyleOverrides(savedStyleOverridesRef.current);
        return alertDialog({ title: "排版微调保存失败", message: errorMessage(err) });
      });
  }

  function updateAvatarOffset(offsetX: number, offsetY: number) {
    if (!modules) return;
    const basicMod = modules.find((m) => m.type === "basic");
    if (!basicMod) return;
    const current = (basicMod.content ?? {}) as Record<string, unknown>;
    const next = { ...current, avatarX: offsetX, avatarY: offsetY };
    setDraft(basicMod.key, next, { immediate: false });
  }

  // JD 诊断建议的写入入口：定位模块/条目/字段后走 setDraft 自动保存；定位失败返回 false 由弹窗提示
  function applySuggestion(
    moduleKey: string,
    itemId: string,
    field: DiagnosisField,
    value: string | string[]
  ): boolean {
    if (!modules) return false;
    const mod = modules.find((m) => m.key === moduleKey);
    if (!mod) return false;
    let next: unknown = null;
    if (field === "description") {
      // 只写 description 会被非空 descriptionItems 覆盖（normalizeDescriptionItemsAndStyle
      // 在读取与保存两侧都让它优先），所以字段形状统一交给 writeDiagnosisValue；
      // 返回 null 表示条目 id 已失效，交给弹窗提示定位失败。
      if (mod.type !== "work" && mod.type !== "projects" && mod.type !== "education") return false;
      next = writeDiagnosisValue(mod.type, mod.content, itemId, value as string);
      if (next === null) return false;
    } else if (field === "text") {
      if (mod.type !== "summary" && mod.type !== "custom") return false;
      next = mod.type === "summary"
        ? writeDiagnosisValue("summary", mod.content, itemId, value as string)
        : { ...(mod.content as { text?: string }), text: value as string };
      if (next === null) return false;
    } else {
      if (mod.type !== "skills") return false;
      next = { items: value as string[] };
    }
    setDraft(moduleKey, next, { immediate: true });
    return true;
  }

  // 监听大纲定位指令：右侧编辑卡片平滑滚动、高亮呼吸光晕与输入框自动聚焦
  useEffect(() => {
    if (!editLocateTarget) return;
    const { entryIndex } = editLocateTarget;

    const timer = setTimeout(() => {
      const container = rightEditorContainerRef.current;
      if (!container) return;
      if (editLocateTarget.key === "__title__") {
        container.querySelector<HTMLInputElement>("[data-resume-title-input]")?.focus();
        return;
      }

      let targetCard: HTMLElement | null = null;
      if (entryIndex !== undefined) {
        targetCard = container.querySelector<HTMLElement>(`[data-edit-card-index="${entryIndex}"]`);
      }
      if (!targetCard) {
        targetCard = container.querySelector<HTMLElement>(`[data-edit-card-index="0"]`) || container;
      }

      if (targetCard) {
        // 计算目标卡片位置，留出 140px 顶部舒适留白（避开吸顶导航，停在视口中偏上方视野舒适区）
        const rect = targetCard.getBoundingClientRect();
        const topOffset = 140;
        const targetScrollY = Math.max(0, window.scrollY + rect.top - topOffset);

        window.scrollTo({
          top: targetScrollY,
          behavior: motionSafeScrollBehavior(),
        });

        targetCard.classList.remove("resume-highlight-pulse");
        void targetCard.offsetWidth;
        targetCard.classList.add("resume-highlight-pulse");
        setTimeout(() => {
          targetCard?.classList.remove("resume-highlight-pulse");
        }, 2300);

        const fieldContainer = editLocateTarget.field
          ? targetCard.querySelector<HTMLElement>(`[data-edit-field="${CSS.escape(editLocateTarget.field)}"]`) : null;
        const inputEl = (fieldContainer ?? targetCard).querySelector<HTMLInputElement | HTMLTextAreaElement>(
          "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), [contenteditable='true']"
        );
        if (inputEl) {
          inputEl.focus({ preventScroll: true });
        }
      }
    }, 75);

    return () => clearTimeout(timer);
  }, [editLocateTarget]);

  return {
    modules,
    titleDraft,
    template,
    styleOverrides,
    customs,
    templateLoadError,
    setTemplateReloadVersion,
    activeKey,
    setActiveKey,
    loadError,
    retryLoad: () => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); },
    status,
    warnings,
    styleCorrupted,
    addOpen,
    setAddOpen,
    mobileTab,
    setMobileTab,
    setEditLocateTarget,
    rightEditorContainerRef,
    saveError,
    storageError,
    savePhase,
    nextRetryAt,
    canUndo,
    canRedo,
    undo,
    redo,
    setDraft,
    handleBeautifyApply,
    addModule,
    removeModule,
    renameModule,
    moveModule,
    commitOrder,
    handleTitleChange,
    saveTitle,
    retrySave,
    switchTemplate,
    handleUpdateStyleOverrides,
    updateAvatarOffset,
    applySuggestion,
  };
}
