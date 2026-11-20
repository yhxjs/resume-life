"use client";

import { useEffect, useRef, useState } from "react";
import {
  resolvePolishSourceIndices,
  splitDraftToItems,
  type PolishContext,
  type PolishMode,
  type PolishResult,
} from "@/lib/polish";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { btnGhost, btnPrimary, inputCls, labelCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";
import { RichTextEditor } from "@/components/resume/rich-text-editor";
import { escapePlainTextToRichHtml, splitRichTextToLines, stripRichText } from "@/lib/rich-text";
import { GripIcon } from "@/components/resume/project-sub-items";
import type { DescriptionListStyle } from "@/lib/modules";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { motionSafeScrollBehavior } from "@/lib/reduced-motion";

function CondenseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block h-3.5 w-3.5 shrink-0 align-text-bottom"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4 17 13-13a2.1 2.1 0 0 1 3 3L7 20a2.1 2.1 0 0 1-3-3Z" />
      <path d="m14 7 3 3M5 1v4M3 3h4M19 13v4M17 15h4" />
    </svg>
  );
}

type StarPolishDialogProps = {
  resumeId: string;
  moduleType: "work" | "projects" | "summary";
  context?: PolishContext;
  currentText: string;
  currentItems?: string[];
  descriptionStyle?: DescriptionListStyle;
  onApply: (text: string, items?: string[], mode?: "replace" | "append") => void;
  triggerLabel?: string;
};

export function StarPolishDialog({
  resumeId,
  moduleType,
  context,
  currentText,
  currentItems,
  descriptionStyle,
  onApply,
  triggerLabel,
}: StarPolishDialogProps) {
  const [open, setOpen] = useState(false);
  const [openedTarget, setOpenedTarget] = useState<string | null>(null);
  const [mode, setMode] = useState<PolishMode>(moduleType === "summary" ? "summary" : "star");
  const [targetRole, setTargetRole] = useState("");
  const [inputItems, setInputItems] = useState<string[]>([]);
  const [inputDescStyle, setInputDescStyle] = useState<DescriptionListStyle>("unordered");
  const [armedInputDesc, setArmedInputDesc] = useState<number | null>(null);
  const [dragInputDesc, setDragInputDesc] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [condenseError, setCondenseError] = useState("");
  const [result, setResult] = useState<PolishResult | null>(null);
  const [editedDraft, setEditedDraft] = useState("");
  const [items, setItems] = useState<string[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [activeSources, setActiveSources] = useState<string[]>([]);
  const [expandedSources, setExpandedSources] = useState<Set<number>>(new Set());
  const [itemSourceIndices, setItemSourceIndices] = useState<Record<number, number[]>>({});
  const [viewMode, setViewMode] = useState<"items" | "raw">("items");
  const [writeMode, setWriteMode] = useState<"replace" | "append">("replace");
  const pendingScrollModeRef = useRef<PolishMode | null>(null);
  const resultContainerRef = useRef<HTMLDivElement | null>(null);
  const starSectionRef = useRef<HTMLDivElement | null>(null);
  const quantifySectionRef = useRef<HTMLDivElement | null>(null);
  const draftSectionRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<{ version: number; controller: AbortController | null }>({ version: 0, controller: null });
  // 分条为实际编辑内容；旧整段字段可能滞后，不能让它误判当前目标已变化。
  const targetContent = currentItems && currentItems.length > 0
    ? currentItems : splitRichTextToLines(currentText);
  const targetKey = JSON.stringify([
    resumeId, moduleType, targetContent.map((text) => stripRichText(text)),
    context?.company ?? "", context?.title ?? "", context?.name ?? "", context?.role ?? "",
  ]);
  const targetChanged = open && openedTarget !== targetKey;

  useEffect(() => {
    if (!pendingScrollModeRef.current || !result) return;
    const modeToScroll = pendingScrollModeRef.current;
    pendingScrollModeRef.current = null;

    let targetEl: HTMLElement | null = null;
    if (modeToScroll === "star" || modeToScroll === "quantify") {
      targetEl =
        starSectionRef.current ||
        quantifySectionRef.current ||
        resultContainerRef.current;
    } else if (modeToScroll === "condense" || modeToScroll === "summary") {
      targetEl = draftSectionRef.current || resultContainerRef.current;
    }

    targetEl?.scrollIntoView?.({
      behavior: motionSafeScrollBehavior(),
      block: "start",
    });
  }, [result]);

  useEffect(() => {
    const request = requestRef.current;
    return () => {
      request.version += 1;
      request.controller?.abort();
      request.controller = null;
    };
  }, []);

  function cancelRequest() {
    requestRef.current.version += 1;
    requestRef.current.controller?.abort();
    requestRef.current.controller = null;
    setLoading(false);
    pendingScrollModeRef.current = null;
  }

  function handleClose() {
    cancelRequest();
    setError("");
    setCondenseError("");
    setOpen(false);
  }

  const dialogRef = useModalFocus(open, handleClose, "[contenteditable], textarea");

  function handleOpen() {
    cancelRequest();
    setOpenedTarget(targetKey);
    const initialInputItems =
      currentItems && currentItems.length > 0
        ? currentItems
        : currentText
          ? splitRichTextToLines(currentText)
          : [""];
    const finalInputItems = initialInputItems.length > 0 ? initialInputItems : [""];
    setInputItems(finalInputItems);
    setInputDescStyle(descriptionStyle ?? "unordered");
    setError("");
    setCondenseError("");
    setResult(null);
    setEditedDraft("");
    setItems([]);
    setSelectedItems(new Set());
    setActiveSources([]);
    setExpandedSources(new Set());
    setItemSourceIndices({});
    pendingScrollModeRef.current = null;
    setMode(moduleType === "summary" ? "summary" : "star");
    setWriteMode("replace");
    setViewMode("items");
    setOpen(true);
  }

  function updateInputItem(idx: number, newVal: string) {
    const next = [...inputItems];
    next[idx] = newVal;
    setInputItems(next);
  }

  function removeInputItem(idx: number) {
    const next = inputItems.filter((_, i) => i !== idx);
    setInputItems(next.length > 0 ? next : [""]);
  }

  function addInputItem() {
    setInputItems([...inputItems, ""]);
  }

  function moveInputItem(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= inputItems.length) return;
    const next = [...inputItems];
    const [moved] = next.splice(idx, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    setInputItems(next);
  }

  function reorderInputItem(from: number, to: number) {
    if (from === to) return;
    const next = [...inputItems];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    setInputItems(next);
  }

  async function handleGenerate() {
    if (requestRef.current.controller || targetChanged) return;
    const version = ++requestRef.current.version;
    const controller = new AbortController();
    requestRef.current.controller = controller;
    setLoading(true);
    setError("");
    setCondenseError("");
    try {
      const sourceParagraphs = inputItems
        .map((s) => stripRichText(s).trim())
        .filter(Boolean);
      // 以当前可见草稿为唯一原文来源，清空后不恢复打开时的旧整段文本。
      const textToGenerate = sourceParagraphs
        .map((s) => (s.startsWith("•") || s.startsWith("·") ? s : `• ${s}`))
        .join("\n");

      const data = await jsonFetch<{ result?: PolishResult }>(`/api/resumes/${resumeId}/polish`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textToGenerate,
          sourceParagraphs: sourceParagraphs.length > 1 ? sourceParagraphs : undefined,
          moduleType,
          mode,
          context,
          targetRole: targetRole.trim(),
        }),
      });
      if (version !== requestRef.current.version) return;
      if (!data.result) throw new Error("润色结果为空，请重试");
      // 来源与成功结果一起切换，失败或取消时继续保留旧结果的实际依据。
      setActiveSources(sourceParagraphs);
      setResult(data.result);
      const draft = data.result.draft || "";
      const initialItems =
        data.result.draftItems && data.result.draftItems.length > 0
          ? data.result.draftItems
          : splitDraftToItems(draft);
      // 接口返回纯文本；进入可编辑富文本状态时转义，后续编辑和视图切换不再重复转义。
      const finalInitialItems = (initialItems.length > 0 ? initialItems : (draft ? [draft] : []))
        .map(escapePlainTextToRichHtml);
      setItems(finalInitialItems);
      setSelectedItems(new Set(finalInitialItems.map((_, i) => i)));
      setEditedDraft(escapePlainTextToRichHtml(draft));

      const initialSourceIndices: Record<number, number[]> = {};
      const details = data.result.draftItemDetails;
      finalInitialItems.forEach((_, idx) => {
        initialSourceIndices[idx] = resolvePolishSourceIndices(details?.[idx], sourceParagraphs.length);
      });
      setItemSourceIndices(initialSourceIndices);
      setExpandedSources(new Set());
      setViewMode("items");
      pendingScrollModeRef.current = mode;
    } catch (err) {
      if (version === requestRef.current.version && !controller.signal.aborted) setError(errorMessage(err));
    } finally {
      if (version === requestRef.current.version) {
        requestRef.current.controller = null;
        setLoading(false);
      }
    }
  }

  async function handleCondenseItems() {
    if (requestRef.current.controller || targetChanged || items.length === 0) return;
    // 本轮输入的位置与最初原文的位置不同，固定两者的映射供回包转换。
    const candidates = items.map((text, index) => ({
      index,
      text: stripRichText(text).trim(),
      sourceIndices: (itemSourceIndices[index] ?? []).filter((sourceIndex) => sourceIndex >= 0 && sourceIndex < activeSources.length),
      selected: selectedItems.has(index),
    })).filter((item) => item.text);
    const selected = candidates.filter((item) => item.selected);
    const source = selected.length > 0 ? selected : candidates;
    if (source.length === 0) return;

    // 有原始资料但关联未知，不等于没有事实依据；先保留草稿供用户恢复关联。
    const unlinked = source.filter((item) => item.sourceIndices.length === 0);
    if (activeSources.length > 0 && unlinked.length > 0) {
      setCondenseError("部分条目尚未关联原始资料。请在来源原文对比中关联后再精简；当前草稿已保留。");
      setExpandedSources(new Set(unlinked.map((item) => item.index)));
      return;
    }

    const rawToCondense = source
      .map(({ text }) => (text.startsWith("•") || text.startsWith("·") ? text : `• ${text}`))
      .join("\n");
    const selectedSourceIndices = new Set(source
      .flatMap((item) => item.sourceIndices)
      .filter((index) => index >= 0 && index < activeSources.length));
    const originalSourceParagraphs = activeSources.filter((_, index) => selectedSourceIndices.has(index));

    const version = ++requestRef.current.version;
    const controller = new AbortController();
    requestRef.current.controller = controller;
    setLoading(true);
    setError("");
    setCondenseError("");
    try {
      const data = await jsonFetch<{ result?: PolishResult }>(`/api/resumes/${resumeId}/polish`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // 各条目已转成纯文本，不能再次解析其中的泛型、标签字面量或实体文本。
          text: rawToCondense,
          sourceParagraphs: source.length > 1 ? source.map((item) => item.text) : undefined,
          originalSourceParagraphs,
          moduleType,
          mode: "condense",
          context,
          targetRole: targetRole.trim(),
        }),
      });
      if (version !== requestRef.current.version) return;
      if (!data.result) throw new Error("精简合并结果为空，请重试");
      setResult(data.result);
      const draft = data.result.draft || "";
      const initialItems =
        data.result.draftItems && data.result.draftItems.length > 0
          ? data.result.draftItems
          : splitDraftToItems(draft);
      const finalInitialItems = (initialItems.length > 0 ? initialItems : (draft ? [draft] : []))
        .map(escapePlainTextToRichHtml);
      setItems(finalInitialItems);
      setSelectedItems(new Set(finalInitialItems.map((_, i) => i)));
      setEditedDraft(escapePlainTextToRichHtml(draft));

      const condenseIndices: Record<number, number[]> = {};
      const details = data.result.draftItemDetails;
      finalInitialItems.forEach((_, idx) => {
        const inputIndices = resolvePolishSourceIndices(details?.[idx], source.length);
        condenseIndices[idx] = [...new Set(inputIndices
          .flatMap((index) => source[index]?.sourceIndices ?? [])
          .filter((index) => index >= 0 && index < activeSources.length))].sort((a, b) => a - b);
      });
      setItemSourceIndices(condenseIndices);
      setExpandedSources(new Set());
      pendingScrollModeRef.current = "condense";
    } catch (err) {
      if (version === requestRef.current.version && !controller.signal.aborted) {
        setCondenseError(errorMessage(err));
      }
    } finally {
      if (version === requestRef.current.version) {
        requestRef.current.controller = null;
        setLoading(false);
      }
    }
  }

  function toggleItemSelection(idx: number) {
    const next = new Set(selectedItems);
    if (next.has(idx)) {
      next.delete(idx);
    } else {
      next.add(idx);
    }
    setSelectedItems(next);
  }

  function toggleSelectAll() {
    if (selectedItems.size === items.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(items.map((_, i) => i)));
    }
  }

  function updateItemAt(idx: number, newVal: string) {
    const next = [...items];
    next[idx] = newVal;
    setItems(next);
  }

  function removeItemAt(idx: number) {
    const next = items.filter((_, i) => i !== idx);
    setItems(next);
    const nextSelected = new Set<number>();
    selectedItems.forEach((oldIdx) => {
      if (oldIdx < idx) nextSelected.add(oldIdx);
      else if (oldIdx > idx) nextSelected.add(oldIdx - 1);
    });
    setSelectedItems(nextSelected);

    const nextExpanded = new Set<number>();
    expandedSources.forEach((oldIdx) => {
      if (oldIdx < idx) nextExpanded.add(oldIdx);
      else if (oldIdx > idx) nextExpanded.add(oldIdx - 1);
    });
    setExpandedSources(nextExpanded);

    const nextIndices: Record<number, number[]> = {};
    Object.entries(itemSourceIndices).forEach(([k, v]) => {
      const oldIdx = Number(k);
      if (oldIdx < idx) nextIndices[oldIdx] = v;
      else if (oldIdx > idx) nextIndices[oldIdx - 1] = v;
    });
    setItemSourceIndices(nextIndices);
  }

  function addItem() {
    const next = [...items, ""];
    setItems(next);
    const nextSelected = new Set(selectedItems);
    nextSelected.add(next.length - 1);
    setSelectedItems(nextSelected);

    setItemSourceIndices((prev) => ({
      ...prev,
      [next.length - 1]: [],
    }));
  }

  function moveItem(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(idx, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    setItems(next);

    const nextSelected = new Set<number>();
    selectedItems.forEach((oldIdx) => {
      if (oldIdx === idx) nextSelected.add(target);
      else if (oldIdx === target) nextSelected.add(idx);
      else nextSelected.add(oldIdx);
    });
    setSelectedItems(nextSelected);

    const nextExpanded = new Set<number>();
    expandedSources.forEach((oldIdx) => {
      if (oldIdx === idx) nextExpanded.add(target);
      else if (oldIdx === target) nextExpanded.add(idx);
      else nextExpanded.add(oldIdx);
    });
    setExpandedSources(nextExpanded);

    const nextIndices: Record<number, number[]> = { ...itemSourceIndices };
    const currentIndices = nextIndices[idx];
    const targetIndices = nextIndices[target];
    if (currentIndices !== undefined) nextIndices[target] = currentIndices;
    else delete nextIndices[target];
    if (targetIndices !== undefined) nextIndices[idx] = targetIndices;
    else delete nextIndices[idx];
    setItemSourceIndices(nextIndices);
  }

  function toggleSourceExpand(idx: number) {
    const next = new Set(expandedSources);
    if (next.has(idx)) {
      next.delete(idx);
    } else {
      next.add(idx);
    }
    setExpandedSources(next);
  }

  function toggleAllSourceExpands() {
    if (expandedSources.size === items.length) {
      setExpandedSources(new Set());
    } else {
      setExpandedSources(new Set(items.map((_, i) => i)));
    }
  }

  function toggleItemSourceLink(itemIdx: number, sourceIdx: number) {
    const current = itemSourceIndices[itemIdx] ?? [];
    const next = current.includes(sourceIdx)
      ? current.filter((i) => i !== sourceIdx)
      : [...current, sourceIdx].sort((a, b) => a - b);
    setItemSourceIndices((prev) => ({
      ...prev,
      [itemIdx]: next,
    }));
  }

  const selectedDraftItems = items
    .filter((_, idx) => selectedItems.has(idx))
    .map((item) => item.trim())
    .filter((item) => stripRichText(item).trim().length > 0);
  const canWrite = !loading && !targetChanged && (viewMode === "items"
    ? selectedDraftItems.length > 0
    : stripRichText(editedDraft).trim().length > 0);

  function handleSwitchView(newView: "items" | "raw") {
    if (newView === "raw" && viewMode === "items") {
      // 空选择也同步为空草稿，避免恢复已删除、清空或取消勾选的内容。
      setEditedDraft(selectedDraftItems.map((s) => (s.startsWith("•") || s.startsWith("·") ? s : `• ${s}`)).join("\n"));
    } else if (newView === "items" && viewMode === "raw") {
      // 只保留唯一匹配的原条目来源；改写或重复文本无法可靠追踪来源。
      const sourcesByText = new Map<string, number[] | null>();
      items.forEach((text, idx) => {
        const normalized = splitRichTextToLines(text);
        if (normalized.length !== 1) return;
        const key = normalized[0]!;
        sourcesByText.set(key, sourcesByText.has(key) ? null : (itemSourceIndices[idx] ?? []));
      });
      const parsed = splitRichTextToLines(editedDraft).filter((item) => stripRichText(item).trim().length > 0);
      const nextIndices: Record<number, number[]> = {};
      parsed.forEach((text, idx) => {
        nextIndices[idx] = sourcesByText.get(text) ?? [];
      });
      setItems(parsed);
      setSelectedItems(new Set(parsed.map((_, i) => i)));
      setItemSourceIndices(nextIndices);
      setExpandedSources(new Set());
    }
    setViewMode(newView);
  }

  function handleWrite() {
    if (requestRef.current.controller || !canWrite) return;
    if (viewMode === "items") {
      const combinedText = selectedDraftItems.map((s) => (s.startsWith("•") || s.startsWith("·") ? s : `• ${s}`)).join("\n");
      if (writeMode === "append" && currentText.trim()) {
        onApply(`${currentText.trim()}\n\n${combinedText}`, selectedDraftItems, "append");
      } else {
        onApply(combinedText, selectedDraftItems, "replace");
      }
    } else {
      const finalDraft = editedDraft.trim();
      const parsed = splitRichTextToLines(finalDraft).filter((item) => stripRichText(item).trim().length > 0);
      if (writeMode === "append" && currentText.trim()) {
        onApply(`${currentText.trim()}\n\n${finalDraft}`, parsed, "append");
      } else {
        onApply(finalDraft, parsed, "replace");
      }
    }
    handleClose();
  }

  // 辅助标题
  const contextDesc = [
    context?.company && `公司：${context.company}`,
    context?.title && `职位：${context.title}`,
    context?.name && `项目：${context.name}`,
    context?.role && `角色：${context.role}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const defaultBtnLabel =
    triggerLabel || (moduleType === "summary" ? "✨ AI 润色" : "✨ STAR 润色与量化");

  return (
    <>
      <button
        type="button"
        className={`${btnGhost} text-primary hover:text-primary-hover`}
        onClick={handleOpen}
      >
        {defaultBtnLabel}
      </button>
      {open && (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={moduleType === "summary" ? "自我评价智能润色" : "STAR 原则智能润色与量化扩写"}
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-[2px]"
      onClick={handleClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="dialog-in relative flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-2xl border border-line bg-card p-4 sm:p-6 shadow-card-float outline-none overflow-hidden"
      >
        <LoadingOverlay
          show={loading}
          message={
            mode === "condense"
              ? "AI 深度精简合并中…"
              : mode === "quantify"
                ? "AI 量化建议分析中…"
                : "AI STAR 原则深度润色中…"
          }
          description="正在整理已有事实和需要核实的信息，请稍候…"
          onCancel={cancelRequest}
          cancelText="取消生成"
        />

        {/* 顶部标题栏 */}
        <div className="flex items-start justify-between border-b border-line pb-3">
          <div>
            <h2 className="text-base sm:text-lg font-semibold tracking-tight text-ink">
              {moduleType === "summary"
                ? "✨ 自我评价智能润色"
                : "✨ 经历润色与量化建议"}
            </h2>
            {contextDesc && (
              <p className="mt-0.5 text-xs text-muted">{contextDesc}</p>
            )}
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-surface hover:text-ink text-xl leading-none"
            onClick={handleClose}
            aria-label="关闭弹窗"
          >
            ×
          </button>
        </div>

        {/* 内容滚动区 */}
        <div className="flex-1 space-y-4 overflow-y-auto py-3 sm:py-4">
          {/* 模式选择 (仅经历类模块展示) */}
          {moduleType !== "summary" && (
            <div>
              <span className={labelCls}>润色模式</span>
              <div className="mt-1.5 flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 sm:py-1.5 text-xs font-medium transition-colors text-left sm:text-center ${
                    mode === "star"
                      ? "border-primary bg-primary text-on-primary"
                      : "border-line bg-card text-ink hover:bg-surface"
                  }`}
                  onClick={() => setMode("star")}
                >
                  🌟 STAR 结构重构（情境/任务/行动/成果）
                </button>
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 sm:py-1.5 text-xs font-medium transition-colors text-left sm:text-center ${
                    mode === "quantify"
                      ? "border-primary bg-primary text-on-primary"
                      : "border-line bg-card text-ink hover:bg-surface"
                  }`}
                  onClick={() => setMode("quantify")}
                >
                  📊 量化建议（核对真实记录与统计口径）
                </button>
                <button
                  type="button"
                  className={`rounded-lg border px-3 py-2 sm:py-1.5 text-xs font-medium transition-colors text-left sm:text-center ${
                    mode === "condense"
                      ? "border-primary bg-primary text-on-primary"
                      : "border-line bg-card text-ink hover:bg-surface"
                  }`}
                  onClick={() => setMode("condense")}
                >
                  <CondenseIcon /> 智能精简合并（提纯聚合，去粗取精）
                </button>
              </div>
            </div>
          )}

          {/* 目标岗位与原始文本 */}
          <div className="space-y-3">
            <label className="block max-w-sm">
              <span className={labelCls}>目标岗位/偏向（选填）</span>
              <input
                className={`${inputCls} mt-1`}
                value={targetRole}
                onChange={(e) => setTargetRole(e.target.value)}
                placeholder="如：初级前端 / 英国数据分析，英语简历 / 香港客服，繁体中文"
              />
              <span className="mt-1 block text-xs text-muted">可补充求职地区、级别和正文语言；未指定时沿用原文。</span>
            </label>

            {/* 描述与成果管理区（与简介编辑页一致） */}
            <div className="rounded-xl border border-line/80 bg-surface/40 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-ink">
                    待润色内容草稿
                  </span>
                  <span className="text-[11px] text-muted">支持分行拖拽排版</span>
                </div>

                {/* 有序 / 无序列表风格切换分段器 */}
                <div className="inline-flex rounded-lg border border-line bg-card p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setInputDescStyle("unordered")}
                    className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                      inputDescStyle === "unordered"
                        ? "bg-primary text-on-primary shadow-2xs font-semibold"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    • 无序列表
                  </button>
                  <button
                    type="button"
                    onClick={() => setInputDescStyle("ordered")}
                    className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                      inputDescStyle === "ordered"
                        ? "bg-primary text-on-primary shadow-2xs font-semibold"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    1. 有序列表
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {inputItems.map((desc, descIndex) => {
                  const isDraggingThisDesc = dragInputDesc === descIndex;
                  const isArmedThisDesc = armedInputDesc === descIndex;

                  return (
                    <div
                      key={descIndex}
                      draggable={isArmedThisDesc}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragInputDesc(descIndex);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", `input-desc:${descIndex}`);
                      }}
                      onDragEnd={() => {
                        setDragInputDesc(null);
                        setArmedInputDesc(null);
                      }}
                      onDragOver={(e) => {
                        if (dragInputDesc === null || dragInputDesc === descIndex) return;
                        e.preventDefault();
                        e.stopPropagation();
                        reorderInputItem(dragInputDesc, descIndex);
                        setDragInputDesc(descIndex);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      className={`flex items-start gap-2 rounded-lg border border-line bg-card p-2.5 shadow-2xs transition-all ${
                        isDraggingThisDesc ? "opacity-30 scale-[0.99]" : "hover:border-line-strong"
                      }`}
                    >
                      <div className="flex flex-col items-center gap-0.5 pt-1 shrink-0">
                        <button
                          type="button"
                          title="拖拽调序"
                          className="cursor-grab text-muted transition-colors hover:text-primary active:cursor-grabbing p-0.5 rounded hover:bg-surface"
                          onMouseDown={() => setArmedInputDesc(descIndex)}
                          onMouseUp={() => setArmedInputDesc(null)}
                        >
                          <GripIcon />
                        </button>
                        <span className="font-mono text-xs font-bold text-primary">
                          {inputDescStyle === "ordered" ? `${descIndex + 1}.` : "•"}
                        </span>
                      </div>

                      <div className="flex flex-col gap-1 shrink-0 pt-0.5">
                        <button
                          type="button"
                          title="上移此行"
                          disabled={descIndex === 0}
                          onClick={() => moveInputItem(descIndex, -1)}
                          className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          title="下移此行"
                          disabled={descIndex === inputItems.length - 1}
                          onClick={() => moveInputItem(descIndex, 1)}
                          className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </div>

                      <div className="flex-1 min-w-0">
                        <RichTextEditor
                          value={desc}
                          onChange={(val) => updateInputItem(descIndex, val)}
                          placeholder={
                            moduleType === "summary"
                              ? "自我评价要点（建议体现核心技术栈/工程深度/业务攻坚等）..."
                              : "工作要点与成果（建议包含技术动作 + 业务影响/量化指标）..."
                          }
                          minHeightClass="min-h-[72px]"
                          ariaLabel={
                            moduleType === "summary"
                              ? `待润色自我评价第 ${descIndex + 1} 行`
                              : `待润色描述第 ${descIndex + 1} 行`
                          }
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => removeInputItem(descIndex)}
                        title="删除该行"
                        className="text-xs text-muted hover:text-danger p-1 rounded transition-colors shrink-0 mt-0.5"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="mt-2.5 flex items-center justify-between">
                <button
                  type="button"
                  onClick={addInputItem}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {moduleType === "summary" ? "+ 添加一行评价" : "+ 添加一行描述"}
                </button>
                <span className="text-[11px] text-faint">每行支持独立上下拖动调序</span>
              </div>
            </div>
          </div>

          {/* 生成按钮 */}
          <div className="flex justify-end">
            <button
              type="button"
              className={btnPrimary}
              onClick={handleGenerate}
              disabled={loading || targetChanged}
            >
              {loading
                ? mode === "condense"
                  ? "AI 深度精简合并中…"
                  : "AI 深度分析润色中…"
                : mode === "condense"
                  ? "开始 AI 智能精简合并"
                  : "开始 AI 智能润色"}
            </button>
          </div>

          {/* 报错信息提示 */}
          {targetChanged && (
            <p role="alert" className={`rounded-lg bg-danger-wash p-3 text-sm ${textErr}`}>
              原内容或职责信息已变化，当前草稿已保留；请关闭并重新打开，载入最新内容后再润色
            </p>
          )}
          {error && (
            <div className={`rounded-lg bg-danger-wash p-3 text-sm ${textErr}`}>
              {error}
            </div>
          )}

          {/* AI 润色结果展示 */}
          {result && (
            <div ref={resultContainerRef} className="space-y-4 pt-2">
              {/* STAR 拆解卡片 */}
              {result.star && (
                <div
                  ref={starSectionRef}
                  data-testid="star-breakdown-section"
                  className="scroll-mt-2 outline-none"
                  tabIndex={-1}
                >
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                    STAR 原则维度拆解
                  </h3>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded-lg border border-line bg-card p-3">
                      <span className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold text-primary">
                        S · 情境背景
                      </span>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink">
                        {result.star.situation || "—"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-line bg-card p-3">
                      <span className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold text-primary">
                        T · 核心任务
                      </span>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink">
                        {result.star.task || "—"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-line bg-card p-3">
                      <span className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold text-primary">
                        A · 关键行动
                      </span>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink whitespace-pre-line">
                        {result.star.action || "—"}
                      </p>
                    </div>
                    <div className="rounded-lg border border-line bg-card p-3">
                      <span className="inline-block rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-bold text-accent">
                        R · 量化结果
                      </span>
                      <p className="mt-1.5 text-xs leading-relaxed text-ink">
                        {result.star.result || "—"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* 量化指标锦囊 */}
              {result.quantifiedTips.length > 0 && (
                <div
                  ref={quantifySectionRef}
                  data-testid="quantify-tips-section"
                  className="scroll-mt-2 outline-none"
                  tabIndex={-1}
                >
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
                    💡 经历量化指标锦囊（指导填写真实数据）
                  </h3>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {result.quantifiedTips.map((tip, idx) => (
                      <div
                        key={idx}
                        className="rounded-lg border border-line-strong/60 bg-surface/70 p-3 text-xs"
                      >
                        <div className="flex items-center gap-1.5 font-medium text-ink">
                          <span className="text-primary">📌</span>
                          <span>{tip.dimension}</span>
                          {tip.metric && (
                            <span className="text-faint">({tip.metric})</span>
                          )}
                        </div>
                        <p className="mt-1 text-muted leading-relaxed">{tip.tip}</p>
                        {tip.example && (
                          <div className="mt-1.5 rounded bg-bg px-2 py-1 font-mono text-[11px] text-accent">
                            {tip.example}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 核心亮点标签 */}
              {result.highlights.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted">提取亮点：</span>
                  {result.highlights.map((h, i) => (
                    <span
                      key={i}
                      className="rounded-full border border-line bg-card px-2.5 py-0.5 text-xs text-ink"
                    >
                      {h}
                    </span>
                  ))}
                </div>
              )}

              {/* 最终可编辑草稿 */}
              <div
                ref={draftSectionRef}
                data-testid="recommended-draft-section"
                className="scroll-mt-2 outline-none"
                tabIndex={-1}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={labelCls}>
                      📝 推荐排版内容
                    </span>
                    {viewMode === "items" && (
                      <span className="text-xs text-muted">
                        （共 {items.length} 项，已勾选 {selectedItems.size} 项）
                      </span>
                    )}
                  </div>

                  {/* 视图切换 Tabs */}
                  <div className="inline-flex rounded-lg border border-line bg-surface/50 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => handleSwitchView("items")}
                      className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                        viewMode === "items"
                          ? "bg-primary text-on-primary shadow-2xs font-semibold"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      • 多项列表（推荐）
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSwitchView("raw")}
                      className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                        viewMode === "raw"
                          ? "bg-primary text-on-primary shadow-2xs font-semibold"
                          : "text-muted hover:text-ink"
                      }`}
                    >
                      📄 整段编辑
                    </button>
                  </div>
                </div>

                {moduleType === "summary" ? (
                  <div className="mt-1.5 mb-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-ink">
                    💡 提示：自我评价应突出有依据的个人优势，不强求新增数字；已有的相关年限、范围或指标请核对口径与限定后保留。
                  </div>
                ) : (
                  <div className="mt-1.5 mb-2 rounded-lg border border-accent/30 bg-accent-wash px-3 py-2 text-xs text-ink">
                    💡 提示：若草稿包含待补充标记（如{" "}
                    <code>[请填入真实数据：具体指标与统计口径]</code>
                    ），请按可核实的记录填写；没有数据时保留准确的定性描述与未知项，不编造数字。
                  </div>
                )}

                <p className="text-xs text-muted">二次精简会对照本轮原始资料。新增或更正事实，请先修改上方待润色内容，再重新生成；来源关联只辅助核对。</p>

                {viewMode === "items" ? (
                  <div className="space-y-3">
                    {/* 快捷批量操作条 */}
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface/40 px-3 py-1.5 text-xs border border-line/60">
                      <label className="flex items-center gap-2 cursor-pointer text-ink font-medium">
                        <input
                          type="checkbox"
                          checked={items.length > 0 && selectedItems.size === items.length}
                          onChange={toggleSelectAll}
                          className="h-3.5 w-3.5 rounded accent-(--primary)"
                        />
                        <span>全选 ({selectedItems.size}/{items.length})</span>
                      </label>
                      <div className="flex items-center gap-2">
                        {activeSources.length > 0 && items.length > 0 && (
                          <button
                            type="button"
                            onClick={toggleAllSourceExpands}
                            className="text-xs text-muted hover:text-primary transition-colors cursor-pointer"
                          >
                            {expandedSources.size === items.length ? "收起所有原文对比" : "展开所有原文对比"}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleCondenseItems}
                          disabled={loading || targetChanged || items.length === 0}
                          title="将当前勾选条目（或全部条目）提纯并智能精简合并为最恰当的条目"
                          className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors disabled:opacity-50 cursor-pointer"
                        >
                          {!loading && <CondenseIcon />}
                          <span>{loading ? "精简合并中…" : "智能精简合并"}</span>
                        </button>
                        <span className="text-[11px] text-muted hidden sm:inline">勾选采纳、独立微调或自由调序</span>
                      </div>
                    </div>

                    {/* 智能精简合并报错信息提示 */}
                    {condenseError && (
                      <div
                        data-testid="condense-error"
                        className={`rounded-lg bg-danger-wash p-3 text-sm ${textErr}`}
                      >
                        {condenseError}
                      </div>
                    )}

                    {/* 多项卡片列表 */}
                    <div className="space-y-2.5">
                      {items.map((itemText, idx) => {
                        const isSelected = selectedItems.has(idx);
                        const isExpanded = expandedSources.has(idx);
                        const rawLinked = itemSourceIndices[idx] ?? [];
                        const linkedSources = rawLinked
                          .filter((sIdx) => sIdx >= 0 && sIdx < activeSources.length)
                          .map((sIdx) => ({ sourceIdx: sIdx, text: activeSources[sIdx]! }));

                        return (
                          <div
                            key={idx}
                            className={`rounded-xl border transition-all p-3 ${
                              isSelected
                                ? "border-line bg-card shadow-2xs"
                                : "border-line/40 bg-surface/30 opacity-70"
                            }`}
                          >
                            {/* 项头部工具栏 */}
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleItemSelection(idx)}
                                  className="h-3.5 w-3.5 rounded accent-(--primary) cursor-pointer"
                                  aria-label={`勾选采纳第 ${idx + 1} 项`}
                                />
                                <span className="font-mono text-xs font-semibold text-primary rounded bg-primary/10 px-1.5 py-0.5">
                                  #{idx + 1}
                                </span>
                                <div className="flex items-center gap-0.5">
                                  <button
                                    type="button"
                                    title="上移此项"
                                    disabled={idx === 0}
                                    onClick={() => moveItem(idx, -1)}
                                    className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30 transition-colors"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    title="下移此项"
                                    disabled={idx === items.length - 1}
                                    onClick={() => moveItem(idx, 1)}
                                    className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30 transition-colors"
                                  >
                                    ↓
                                  </button>
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5">
                                {activeSources.length > 0 && (
                                  <button
                                    type="button"
                                    onClick={() => toggleSourceExpand(idx)}
                                    aria-expanded={isExpanded}
                                    className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                                      isExpanded
                                        ? "bg-primary/15 text-primary border border-primary/30 font-semibold"
                                        : "bg-surface/70 text-muted hover:text-ink hover:bg-surface border border-line"
                                    }`}
                                    title={isExpanded ? "收起来源原文对比" : "向上展开来源原文以供对比"}
                                    aria-label={`展开第 ${idx + 1} 项来源原文对比`}
                                  >
                                    <span>{isExpanded ? "收起原文对比" : "展开原文对比"}</span>
                                    <span className="rounded bg-primary/10 px-1 py-0.2 font-mono text-[10px] text-primary">
                                      {linkedSources.length}段
                                    </span>
                                    <span className="text-[10px] font-mono">{isExpanded ? "▲" : "▼"}</span>
                                  </button>
                                )}

                                <button
                                  type="button"
                                  title="删除此项"
                                  onClick={() => removeItemAt(idx)}
                                  className="rounded px-1.5 py-0.5 text-xs text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                                >
                                  × 删除
                                </button>
                              </div>
                            </div>

                            {/* 向上展开的来源原文对比卡片（位于编辑区上方） */}
                            {isExpanded && activeSources.length > 0 && (
                              <div
                                data-testid={`source-comparison-${idx}`}
                                className="mb-2.5 rounded-xl border border-primary/25 bg-surface/80 p-3 text-xs shadow-2xs transition-all"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-1.5 mb-2 pb-1.5 border-b border-line/60">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold text-primary">📖 来源原文对比</span>
                                    <span className="text-[11px] text-muted">
                                      （已关联 {linkedSources.length}/{activeSources.length} 个来源段落）
                                    </span>
                                  </div>

                                  {activeSources.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-1">
                                      <span className="text-[11px] text-muted">关联段落：</span>
                                      {activeSources.map((_, sIdx) => {
                                        const isLinked = (itemSourceIndices[idx] ?? []).includes(sIdx);
                                        return (
                                          <button
                                            key={sIdx}
                                            type="button"
                                            onClick={() => toggleItemSourceLink(idx, sIdx)}
                                            className={`rounded px-1.5 py-0.5 text-[11px] font-mono transition-colors cursor-pointer ${
                                              isLinked
                                                ? "bg-primary text-on-primary font-semibold shadow-2xs"
                                                : "bg-card text-muted hover:text-ink border border-line"
                                            }`}
                                            title={isLinked ? `点击取消关联段落 ${sIdx + 1}` : `点击关联段落 ${sIdx + 1}`}
                                            aria-label={isLinked ? `点击取消关联段落 ${sIdx + 1}` : `点击关联段落 ${sIdx + 1}`}
                                            aria-pressed={isLinked}
                                          >
                                            段落 {sIdx + 1}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>

                                {/* 来源段落列表 */}
                                <div className="space-y-2">
                                  {linkedSources.length === 0 && <p className="text-muted">来源待关联</p>}
                                  {linkedSources.map(({ sourceIdx, text }) => (
                                    <div
                                      key={sourceIdx}
                                      className="rounded-lg border border-line bg-card p-2.5 shadow-2xs"
                                    >
                                      <div className="flex items-center justify-between mb-1">
                                        <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                                          <span>¶</span>
                                          <span>段落 {sourceIdx + 1}</span>
                                        </span>
                                        <span className="text-[10px] text-muted">
                                          {text.length} 字符
                                        </span>
                                      </div>
                                      <p className="text-ink leading-relaxed whitespace-pre-wrap select-text font-sans text-xs">
                                        {text}
                                      </p>
                                    </div>
                                  ))}
                                </div>

                                <div className="mt-2 flex items-center justify-between text-[11px] text-muted pt-1 border-t border-line/40">
                                  <span>⬇ 下方为本条润色与经历量化扩写结果（可在此直接微调编辑）：</span>
                                </div>
                              </div>
                            )}

                            {/* 独立富文本编辑器 */}
                            <RichTextEditor
                              value={itemText}
                              onChange={(val) => updateItemAt(idx, val)}
                              placeholder={
                                moduleType === "summary"
                                  ? "在此编辑该项自我评价…"
                                  : "在此编辑该项经历描述…"
                              }
                              minHeightClass="min-h-[72px]"
                              ariaLabel={`${moduleType === "summary" ? "自我评价" : "经历条目"}第 ${idx + 1} 项`}
                            />
                          </div>
                        );
                      })}
                    </div>

                    {/* 底部添加新项按钮 */}
                    <div className="flex items-center justify-between pt-1">
                      <button
                        type="button"
                        onClick={addItem}
                        className="text-xs font-medium text-primary hover:underline transition-colors cursor-pointer"
                      >
                        {moduleType === "summary" ? "+ 添加一项自我评价" : "+ 添加一项经历描述"}
                      </button>
                      <span className="text-[11px] text-faint">
                        写入时将仅采用已勾选的条目
                      </span>
                    </div>
                  </div>
                ) : (
                  <RichTextEditor
                    value={editedDraft}
                    onChange={setEditedDraft}
                    placeholder="AI 润色生成的推荐排版草稿…"
                    minHeightClass="min-h-[160px]"
                    ariaLabel="推荐排版草稿"
                  />
                )}
              </div>

              {/* 写入方式 */}
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <span className={labelCls}>写入方式：</span>
                <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                  <input
                    type="radio"
                    checked={writeMode === "replace"}
                    onChange={() => setWriteMode("replace")}
                    className="h-3.5 w-3.5 accent-(--primary)"
                  />
                  替换现有内容
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-ink">
                  <input
                    type="radio"
                    checked={writeMode === "append"}
                    onChange={() => setWriteMode("append")}
                    className="h-3.5 w-3.5 accent-(--primary)"
                  />
                  追加到现有内容末尾
                </label>
              </div>
            </div>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <button
            type="button"
            className={btnGhost}
            onClick={handleClose}
          >
            取消
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={handleWrite}
            disabled={!canWrite}
          >
            确认写入简历
          </button>
        </div>
      </div>
    </div>
      )}
    </>
  );
}
