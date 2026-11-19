"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import {
  BUILTIN_STYLES,
  normalizeStyle,
  type CustomTemplate,
  type ResumeStyle,
} from "@/lib/templates";
import { errorMessage } from "@/lib/error-message";
import { readTemplateList, readTemplateResponse } from "@/lib/template-library-response";
import { useRecordDeletion } from "@/hooks/use-record-deletion";

export function useTemplateLibrary() {
  const [customs, setCustoms] = useState<CustomTemplate[]>([]);
  const [draft, setDraft] = useState<ResumeStyle>(BUILTIN_STYLES.modern);
  const [draftName, setDraftNameState] = useState("我的模板");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [aiPrompt, setAiPromptState] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiNote, setAiNote] = useState("");
  const [loadError, setLoadError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  // 回包只属于发起时的编辑版本；ref 同时拦截同一事件内的重复操作。
  const editVersionRef = useRef(0);
  const aiPromptVersionRef = useRef(0);
  const operationRef = useRef<AbortController | null>(null);
  const repairRef = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const removed = useRef(new Set<number>());
  const listRequestRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationRef.current?.abort();
      operationRef.current = null;
      repairRef.current = null;
      listRequestRef.current?.abort();
      listRequestRef.current = null;
    };
  }, []);

  const cancelRepair = useCallback(() => {
    const controller = repairRef.current;
    if (!controller) return;
    controller.abort();
    if (operationRef.current === controller) operationRef.current = null;
    repairRef.current = null;
  }, []);

  const setAiPrompt = useCallback((value: string) => {
    aiPromptVersionRef.current++;
    setAiPromptState(value);
  }, []);

  const setDraftName = useCallback((value: string) => {
    cancelRepair();
    editVersionRef.current++;
    setDraftNameState(value);
  }, [cancelRepair]);

  const commit = useCallback(() => setDraft((value) => normalizeStyle(value) ?? value), []);
  const set = useCallback(<K extends keyof ResumeStyle>(key: K, value: ResumeStyle[K]) => {
    cancelRepair();
    editVersionRef.current++;
    setDraft((previous) => ({ ...previous, [key]: value }));
  }, [cancelRepair]);
  const refreshCustoms = useCallback(() => {
    if (!mounted.current) return Promise.resolve();
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    return jsonFetch<unknown>("/api/templates", { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (listRequestRef.current !== controller || controller.signal.aborted) return;
        setCustoms(readTemplateList(response).filter(template => !removed.current.has(template.id)));
        setLoadError("");
      })
      .catch((reason) => {
        // 列表读取失败独立展示，不把已确认的保存或删除误报为失败。
        if (listRequestRef.current === controller && !controller.signal.aborted) setLoadError(errorMessage(reason));
      })
      .finally(() => {
        if (listRequestRef.current === controller) listRequestRef.current = null;
      });
  }, []);

  const deletion = useRecordDeletion({
    baseUrl: "/api/templates",
    confirmTitle: "删除模板",
    confirmMessage: (id, title) => `确定删除模板 #${id}「${title}」吗？模板及其模型标签将删除，正在使用它的简历将回退为经典单栏；简历内容及各自的样式覆盖保留。当前检查器草稿保留，可另存为新模板。`,
    readExisting: async (id, signal) => readTemplateList(await jsonFetch<unknown>("/api/templates", { signal, cache: "no-store" })).some(template => template.id === id),
    recordLabel: "模板",
    listLabel: "模板列表",
  }, id => {
    removed.current.add(id);
    setCustoms(previous => previous.filter(template => template.id !== id));
    setEditingId(current => current === id ? null : current);
    void refreshCustoms();
  });

  function beginOperation() {
    if (!mounted.current || operationRef.current || !deletion.canStart()) return null;
    const controller = new AbortController();
    operationRef.current = controller;
    return controller;
  }

  function isCurrent(controller: AbortController) {
    return mounted.current && operationRef.current === controller && !controller.signal.aborted;
  }

  function finishOperation(controller: AbortController) {
    if (!isCurrent(controller)) return;
    operationRef.current = null;
    if (repairRef.current === controller) repairRef.current = null;
    setAiLoading(false);
    setSaving(false);
  }

  useEffect(() => {
    void refreshCustoms();
    return () => {
      listRequestRef.current?.abort();
      listRequestRef.current = null;
    };
  }, [refreshCustoms, reloadVersion]);

  function acceptSavedTemplate(template: CustomTemplate) {
    setCustoms((previous) => [...previous.filter((entry) => entry.id !== template.id), template]
      .sort((left, right) => left.id - right.id));
  }

  function loadStyle(template: { id: number | null; name: string; style: ResumeStyle; corrupted?: boolean }) {
    if (!mounted.current || (template.id !== null && removed.current.has(template.id))) return;
    const apply = () => {
      editVersionRef.current++;
      setDraft(template.style);
      setDraftNameState(template.name);
      setEditingId(template.id);
      setAiNote(template.corrupted ? "正在修复损坏模板：当前为默认样式，调整后请保存修改。" : "");
    };
    if (!template.corrupted) { cancelRepair(); apply(); return; }
    const controller = beginOperation();
    if (!controller) return;
    repairRef.current = controller;
    const editVersion = editVersionRef.current;
    return confirmDialog({
      title: "修复损坏模板",
      message: `模板 #${template.id}「${template.name}」数据损坏，是否载入默认样式进行修复？原记录暂不改变，调整后点击「保存修改」才会替换损坏数据。`,
      signal: controller.signal,
    }).then((confirmed) => {
      if (isCurrent(controller) && confirmed && editVersion === editVersionRef.current) apply();
    }).finally(() => finishOperation(controller));
  }

  async function aiGenerate() {
    const prompt = aiPrompt.trim();
    if (!prompt) return;
    const controller = beginOperation();
    if (!controller) return;
    const editVersion = editVersionRef.current;
    const promptVersion = aiPromptVersionRef.current;
    setAiLoading(true); setAiNote("");
    try {
      const response = await jsonFetch<{ style: ResumeStyle }>("/api/styles/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });
      if (!isCurrent(controller) || editVersion !== editVersionRef.current || promptVersion !== aiPromptVersionRef.current) return;
      setDraft((current) => normalizeStyle(response.style) ?? current);
      setEditingId(null);
      setAiNote("已生成并应用到预览，满意后可另存为新模板");
    } catch (reason) {
      if (isCurrent(controller) && editVersion === editVersionRef.current && promptVersion === aiPromptVersionRef.current) {
        await alertDialog({ title: "AI 生成失败", message: errorMessage(reason), signal: controller.signal });
      }
    } finally { finishOperation(controller); }
  }

  async function saveNew() {
    const controller = beginOperation();
    if (!controller) return;
    const name = draftName.trim();
    const editVersion = editVersionRef.current;
    try {
      if (!name) { await alertDialog({ title: "保存模板", message: "请先填写模板名称", signal: controller.signal }); return; }
      setSaving(true);
      const response = await jsonFetch<unknown>("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, style: draft }),
        signal: controller.signal,
      });
      if (!isCurrent(controller)) return;
      const created = readTemplateResponse(response);
      acceptSavedTemplate(created);
      if (editVersion === editVersionRef.current) {
        setEditingId(created.id);
        setDraftNameState(created.name);
        setAiNote("");
      }
      await refreshCustoms();
    } catch (reason) {
      if (isCurrent(controller) && editVersion === editVersionRef.current) await alertDialog({ title: "保存模板失败", message: errorMessage(reason), signal: controller.signal });
    } finally { finishOperation(controller); }
  }

  async function saveChanges() {
    if (editingId === null || removed.current.has(editingId)) return;
    const controller = beginOperation();
    if (!controller) return;
    setSaving(true);
    const editVersion = editVersionRef.current;
    try {
      const response = await jsonFetch<unknown>(`/api/templates/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draftName.trim(), style: draft }),
        signal: controller.signal,
      });
      if (!isCurrent(controller)) return;
      const saved = readTemplateResponse(response, editingId);
      acceptSavedTemplate(saved);
      if (editVersion === editVersionRef.current) {
        setDraftNameState(saved.name);
        setAiNote("");
      }
      await refreshCustoms();
    } catch (reason) {
      if (isCurrent(controller) && editVersion === editVersionRef.current) await alertDialog({ title: "保存修改失败", message: errorMessage(reason), signal: controller.signal });
    } finally { finishOperation(controller); }
  }

  async function removeCustom(template: CustomTemplate) {
    if (!mounted.current || operationRef.current) return;
    await deletion.remove(template.id, `${template.name}；创建时间：${template.created_at || "未记录"}；修改时间：${template.updated_at || "未记录"}`);
  }

  return {
    customs, draft, draftName, setDraftName, editingId,
    aiPrompt, setAiPrompt, aiLoading, saving, aiNote, loadError, deletion,
    reloadCustoms: () => setReloadVersion((version) => version + 1),
    commit, set, loadStyle, aiGenerate, saveNew, saveChanges, removeCustom,
  };
}

export type TemplateLibraryController = ReturnType<typeof useTemplateLibrary>;

export function useStylePreview(draft: ResumeStyle) {
  const previewRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.7);
  const [paperHeight, setPaperHeight] = useState(1123);
  const [mobileTab, setMobileTab] = useState<"inspector" | "preview">("inspector");

  useEffect(() => {
    const container = previewRef.current;
    const paper = paperRef.current;
    if (!container || !paper) return;
    const update = () => {
      if (container.clientWidth > 0) {
        setScale(Math.min(1, container.clientWidth / 794));
        setPaperHeight(paper.offsetHeight);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(paper);
    return () => observer.disconnect();
  }, [draft, mobileTab]);

  return { previewRef, paperRef, scale, paperHeight, mobileTab, setMobileTab };
}
