"use client";

import React, { useEffect, useRef, useState } from "react";
import type { ModuleData } from "@/lib/modules";
import { registerEscapeLayer } from "@/lib/escape-layer";

export type OutlineSubItem = {
  id: string;
  title: string;
  sub?: string;
  index: number;
};

interface ModuleOutlineProps {
  modules: ModuleData[];
  activeKey: string;
  onSelect: (key: string) => void;
  onOrderCommit: (orderedKeys: string[]) => void;
  onAddModule: () => void;
  /** 点击定位至预览区域对应位置（可带条目索引） */
  onLocate?: (moduleKey: string, entryIndex?: number) => void;
}

const TYPE_ICONS: Record<string, string> = {
  basic: "👤",
  education: "🎓",
  work: "💼",
  projects: "🚀",
  skills: "⚡",
  summary: "📝",
  custom: "📄",
};

/**
 * 提取模块内部的具体细项条目，供大纲树层级展示与深入定位
 */
function extractSubItems(module: ModuleData): OutlineSubItem[] {
  const { type, content } = module;
  if (!content) return [];

  if (type === "work") {
    const list = Array.isArray(content) ? content : [];
    return list.map((it: Record<string, unknown>, idx) => ({
      id: `${module.key}-work-${idx}`,
      title: String(it.company || "未命名公司").trim(),
      sub: [it.title, it.start || it.end ? `${it.start || ""}~${it.end || ""}` : ""]
        .filter(Boolean)
        .join(" · "),
      index: idx,
    }));
  }

  if (type === "projects") {
    const list = Array.isArray(content) ? content : [];
    return list.map((it: Record<string, unknown>, idx) => ({
      id: `${module.key}-proj-${idx}`,
      title: String(it.name || "未命名项目").trim(),
      sub: [it.role, it.start || it.end ? `${it.start || ""}~${it.end || ""}` : ""]
        .filter(Boolean)
        .join(" · "),
      index: idx,
    }));
  }

  if (type === "education") {
    const list = Array.isArray(content) ? content : [];
    return list.map((it: Record<string, unknown>, idx) => ({
      id: `${module.key}-edu-${idx}`,
      title: String(it.school || "未命名学校").trim(),
      sub: [it.degree, it.field].filter(Boolean).join(" · "),
      index: idx,
    }));
  }

  if (type === "skills") {
    const items = ((content as { items?: string[] })?.items ?? []).filter(Boolean);
    if (!items.length) return [];
    return items.map((skill, idx) => ({
      id: `${module.key}-skill-${idx}`,
      title: skill,
      index: idx,
    }));
  }

  if (type === "summary") {
    const text = String((content as { text?: string })?.text ?? "").trim();
    if (!text) return [];
    const preview = text.length > 36 ? text.slice(0, 36) + "..." : text;
    return [
      {
        id: `${module.key}-summary-0`,
        title: preview,
        index: 0,
      },
    ];
  }

  if (type === "custom") {
    const list = Array.isArray(content) ? content : [];
    return list.map((it: Record<string, unknown>, idx) => ({
      id: `${module.key}-custom-${idx}`,
      title: String(it.title || "未命名条目").trim(),
      sub: [it.subTitle, it.start || it.end ? `${it.start || ""}~${it.end || ""}` : ""]
        .filter(Boolean)
        .join(" · "),
      index: idx,
    }));
  }

  if (type === "basic") {
    const c = (content ?? {}) as Record<string, string>;
    const name = c.name?.trim();
    const contact = [c.phone, c.email].filter(Boolean).join(" · ");
    return [
      {
        id: `${module.key}-basic-0`,
        title: name ? `姓名：${name}` : "个人基本资料",
        sub: contact || undefined,
        index: 0,
      },
    ];
  }

  return [];
}

/**
 * 预览区左侧悬浮按钮与弹出大纲抽屉：
 * 点击悬浮按钮后滑出完整大纲树，支持自由上下拖拽排序、展开细项与精准丝滑跳转定位。
 */
export function ModuleOutline({
  modules,
  activeKey,
  onSelect,
  onOrderCommit,
  onAddModule,
  onLocate,
}: ModuleOutlineProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({});
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);

  // 点击外部或按 ESC 键收起浮层
  useEffect(() => {
    if (!isOpen) return;
    const unregister = registerEscapeLayer();
    function handleClickOutside(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsOpen(false);
        triggerBtnRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      unregister();
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function toggleSubItems(key: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedModules((prev) => ({
      ...prev,
      [key]: prev[key] === undefined ? false : !prev[key],
    }));
  }

  // 键盘与按钮快捷上移/下移
  function move(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= modules.length) return;
    const next = [...modules];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(to, 0, item);
    onOrderCommit(next.map((m) => m.key));
  }

  function handleDragStart(e: React.DragEvent<HTMLDivElement>, key: string) {
    setDraggedKey(key);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>, targetKey: string) {
    e.preventDefault();
    if (!draggedKey || draggedKey === targetKey) {
      setDraggedKey(null);
      return;
    }

    const fromIndex = modules.findIndex((m) => m.key === draggedKey);
    const toIndex = modules.findIndex((m) => m.key === targetKey);
    if (fromIndex === -1 || toIndex === -1) {
      setDraggedKey(null);
      return;
    }

    const next = [...modules];
    const [moved] = next.splice(fromIndex, 1);
    if (moved) {
      next.splice(toIndex, 0, moved);
      onOrderCommit(next.map((m) => m.key));
    }
    setDraggedKey(null);
  }

  function handleLocateModule(key: string) {
    onSelect(key);
    onLocate?.(key);
    setIsOpen(false);
  }

  function handleLocateSubItem(moduleKey: string, entryIndex: number) {
    onSelect(moduleKey);
    onLocate?.(moduleKey, entryIndex);
    setIsOpen(false);
  }

  return (
    <div className="no-print relative" ref={drawerRef}>
      {/* 悬浮胶囊按钮：常驻在预览区域左上角 */}
      <button
        ref={triggerBtnRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`group flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur-md transition-all duration-200 select-none ${
          isOpen
            ? "border-primary bg-primary text-on-primary shadow-lg ring-2 ring-primary/20"
            : "border-line/90 bg-card/90 text-ink hover:border-primary/60 hover:bg-card hover:shadow-lg active:scale-95"
        }`}
        title="展开简历模块大纲树与排序列表"
      >
        <span className="text-sm">🗂️</span>
        <span className="font-semibold">大纲排序</span>
        <span className={`text-[10px] text-muted group-hover:text-ink transition-transform ${isOpen ? "rotate-90 text-on-primary" : ""}`}>
          ›
        </span>
      </button>

      {/* 展开后的悬浮大纲抽屉面板 */}
      {isOpen && (
        <div className="absolute left-0 lg:left-full lg:ml-2 top-0 z-50 w-80 sm:w-88 max-h-[calc(100vh-200px)] flex flex-col rounded-2xl border border-line bg-card/95 p-3 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-left-2 duration-150">
          {/* 面板头部 */}
          <div className="flex items-center justify-between border-b border-line pb-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm">🗂️</span>
              <span className="text-xs font-semibold text-ink">模块大纲与结构排序</span>
              <span className="rounded-full bg-surface px-1.5 py-0.2 text-[10px] text-muted">
                {modules.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onAddModule}
                className="text-[11px] text-primary hover:underline font-medium"
              >
                + 添加
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-full p-1 text-muted hover:bg-surface hover:text-ink transition-colors"
                title="关闭大纲面板 (Esc)"
              >
                ✕
              </button>
            </div>
          </div>

          <p className="py-2 text-[11px] text-muted">
            💡 拖拽左侧抓手（⠿）自由排序，点击细项跳转定位：
          </p>

          {/* 模块列表（支持纵向独立滚动） */}
          <div className="flex-1 overflow-y-auto pr-1 space-y-1.5 max-h-[460px]">
            {modules.map((m, index) => {
              const isActive = m.key === activeKey;
              const isDragging = m.key === draggedKey;
              const subItems = extractSubItems(m);
              const isSubExpanded = expandedModules[m.key] !== false; // 默认展开

              return (
                <div
                  key={m.key}
                  className={`rounded-lg border transition-all ${
                    isActive
                      ? "border-primary/50 bg-primary/5 shadow-xs"
                      : "border-line/70 bg-surface/40 hover:border-line hover:bg-surface/80"
                  } ${isDragging ? "opacity-30 border-dashed border-primary" : ""}`}
                >
                  {/* 模块主栏 */}
                  <div
                    draggable
                    onDragStart={(e) => handleDragStart(e, m.key)}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDrop(e, m.key)}
                    onDragEnd={() => setDraggedKey(null)}
                    className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 select-none"
                  >
                    {/* 左侧抓手与模块标题 */}
                    <div
                      className="flex flex-1 items-center gap-1.5 min-w-0 cursor-pointer"
                      onClick={() => handleLocateModule(m.key)}
                      title="点击定位到此模块"
                    >
                      <span
                        className="cursor-grab active:cursor-grabbing text-muted/60 hover:text-ink text-sm shrink-0 px-0.5"
                        title="按住上下拖拽排序"
                      >
                        ⠿
                      </span>
                      {subItems.length > 0 && (
                        <button
                          type="button"
                          onClick={(e) => toggleSubItems(m.key, e)}
                          className="text-muted hover:text-ink text-[10px] w-3.5 h-3.5 flex items-center justify-center shrink-0"
                          title={isSubExpanded ? "折叠细项" : "展开细项"}
                        >
                          {isSubExpanded ? "▼" : "▶"}
                        </button>
                      )}
                      <span className="text-xs shrink-0">{TYPE_ICONS[m.type] ?? "📄"}</span>
                      <span className="text-xs font-medium text-ink truncate">{m.label}</span>
                      <span className="text-[10px] font-mono text-faint shrink-0">#{index + 1}</span>
                    </div>

                    {/* 操作按钮组 */}
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                        className="rounded p-0.5 text-[11px] text-muted hover:bg-card hover:text-ink disabled:opacity-20"
                        title="上移"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={index === modules.length - 1}
                        onClick={() => move(index, 1)}
                        className="rounded p-0.5 text-[11px] text-muted hover:bg-card hover:text-ink disabled:opacity-20"
                        title="下移"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => handleLocateModule(m.key)}
                        className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                          isActive
                            ? "bg-primary text-on-primary font-medium"
                            : "text-muted hover:text-ink hover:bg-card"
                        }`}
                        title="在纸张预览中滚动至此模块并闪烁高亮"
                      >
                        定位
                      </button>
                    </div>
                  </div>

                  {/* 模块内部细项列表 */}
                  {subItems.length > 0 && isSubExpanded && (
                    <div className="border-t border-line/40 bg-card/50 px-2.5 py-1.5 space-y-1">
                      {subItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => handleLocateSubItem(m.key, item.index)}
                          className="flex w-full items-center justify-between gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-primary/10 hover:text-primary cursor-pointer transition-colors group/item"
                          title="点击在预览中丝滑滚动并高亮此细项"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="h-1.5 w-1.5 rounded-full bg-line group-hover/item:bg-primary shrink-0" />
                            <span className="truncate text-ink group-hover/item:text-primary font-medium">
                              {item.title}
                            </span>
                            {item.sub && (
                              <span className="truncate text-[11px] text-muted">
                                {item.sub}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-primary opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0">
                            跳转 ↗
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
