"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import {
  BUILTIN_STYLES,
  normalizeStyle,
  type CustomTemplate,
  type ResumeStyle,
} from "@/lib/templates";
import { errorMessage } from "@/lib/error-message";

export function useTemplateLibrary() {
  const [customs, setCustoms] = useState<CustomTemplate[]>([]);
  const [draft, setDraft] = useState<ResumeStyle>(BUILTIN_STYLES.modern);
  const [draftName, setDraftNameState] = useState("我的模板");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiNote, setAiNote] = useState("");
  const [loadError, setLoadError] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  // 回包只属于发起时的编辑版本；ref 同时拦截同一事件内的重复操作。
  const editVersionRef = useRef(0);
  const operationRef = useRef(false);

  useEffect(() => () => { editVersionRef.current++; }, []);

  const setDraftName = useCallback((value: string) => {
    editVersionRef.current++;
    setDraftNameState(value);
  }, []);

  const commit = useCallback(() => setDraft((value) => normalizeStyle(value) ?? value), []);
  const set = useCallback(<K extends keyof ResumeStyle>(key: K, value: ResumeStyle[K]) => {
    editVersionRef.current++;
    setDraft((previous) => ({ ...previous, [key]: value }));
  }, []);
  const refreshCustoms = useCallback(async () => {
    const response = await jsonFetch<{ items: CustomTemplate[] }>("/api/templates");
    setCustoms(response.items);
  }, []);

  useEffect(() => {
    let cancelled = false;
    jsonFetch<{ items: CustomTemplate[] }>("/api/templates")
      .then((response) => {
        if (cancelled) return;
        setCustoms(response.items);
        setLoadError("");
      })
      .catch((reason) => {
        // 自定义模板拉取失败要显式提示，否则用户只会看到一个空模板列表
        if (!cancelled) setLoadError(errorMessage(reason));
      });
    return () => { cancelled = true; };
  }, [reloadVersion]);

  function loadStyle(template: { id: number | null; name: string; style: ResumeStyle; corrupted?: boolean }) {
    const apply = () => {
      editVersionRef.current++;
      setDraft(template.style);
      setDraftNameState(template.name);
      setEditingId(template.id);
      setAiNote(template.corrupted ? "正在修复损坏模板：当前为默认样式，调整后请保存修改。" : "");
    };
    if (!template.corrupted) { apply(); return; }
    const editVersion = editVersionRef.current;
    return confirmDialog({
      title: "修复损坏模板",
      message: "模板数据损坏，是否载入默认样式进行修复？原记录暂不改变，调整后点击「保存修改」才会替换损坏数据。",
    }).then((confirmed) => { if (confirmed && editVersion === editVersionRef.current) apply(); });
  }

  async function aiGenerate() {
    const prompt = aiPrompt.trim();
    if (!prompt || operationRef.current) return;
    operationRef.current = true;
    const editVersion = editVersionRef.current;
    setAiLoading(true); setAiNote("");
    try {
      const response = await jsonFetch<{ style: ResumeStyle }>("/api/styles/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (editVersion !== editVersionRef.current) return;
      setDraft((current) => normalizeStyle(response.style) ?? current);
      setEditingId(null);
      setAiNote("已生成并应用到预览，满意后可另存为新模板");
    } catch (reason) {
      if (editVersion === editVersionRef.current) await alertDialog({ title: "AI 生成失败", message: errorMessage(reason) });
    } finally { operationRef.current = false; setAiLoading(false); }
  }

  async function saveNew() {
    if (operationRef.current) return;
    const name = draftName.trim();
    if (!name) { await alertDialog({ title: "保存模板", message: "请先填写模板名称" }); return; }
    operationRef.current = true;
    setSaving(true);
    const editVersion = editVersionRef.current;
    try {
      const created = await jsonFetch<CustomTemplate>("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, style: draft }),
      });
      await refreshCustoms();
      if (editVersion !== editVersionRef.current) return;
      setEditingId(created.id);
      setDraftNameState(created.name);
    } catch (reason) {
      if (editVersion === editVersionRef.current) await alertDialog({ title: "保存模板失败", message: errorMessage(reason) });
    } finally { operationRef.current = false; setSaving(false); }
  }

  async function saveChanges() {
    if (editingId === null || operationRef.current) return;
    operationRef.current = true;
    setSaving(true);
    const editVersion = editVersionRef.current;
    try {
      const saved = await jsonFetch<CustomTemplate>(`/api/templates/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draftName.trim(), style: draft }),
      });
      await refreshCustoms();
      if (editVersion !== editVersionRef.current) return;
      setDraftNameState(saved.name);
      setAiNote("");
    } catch (reason) {
      if (editVersion === editVersionRef.current) await alertDialog({ title: "保存修改失败", message: errorMessage(reason) });
    } finally { operationRef.current = false; setSaving(false); }
  }

  async function removeCustom(template: CustomTemplate) {
    const confirmed = await confirmDialog({
      title: "删除模板",
      message: `确定删除「${template.name}」吗？正在使用它的简历将回退为经典单栏。`,
      danger: true,
    });
    if (!confirmed) return;
    try {
      await jsonFetch(`/api/templates/${template.id}`, { method: "DELETE" });
      await refreshCustoms();
      setEditingId((current) => current === template.id ? null : current);
    } catch (reason) {
      await alertDialog({ title: "删除模板失败", message: errorMessage(reason) });
    }
  }

  return {
    customs, draft, draftName, setDraftName, editingId,
    aiPrompt, setAiPrompt, aiLoading, saving, aiNote, loadError,
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
