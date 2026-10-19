"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EntrySubItem } from "@/lib/modules";
import { badgeCls, inputCls } from "@/lib/ui";
import { genEntryId } from "./project-entry-id";

const DEFAULT_PRESET_SUB_LABELS = ["技术栈", "项目链接", "团队规模", "核心贡献"];

interface AutoResizeTextareaProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  className?: string;
}

function AutoResizeTextarea({
  value,
  onChange,
  placeholder,
  className,
}: AutoResizeTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + border}px`;
  };

  useLayoutEffect(() => {
    adjustHeight();
  }, [value]);

  useEffect(() => {
    const onResize = () => adjustHeight();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={value}
      onChange={(e) => {
        onChange(e);
        adjustHeight();
      }}
      placeholder={placeholder}
      className={className}
      style={{
        resize: "none",
        overflow: "hidden",
        ...({ fieldSizing: "content" } as React.CSSProperties),
      }}
    />
  );
}

export function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="2.5" r="1.5" />
      <circle cx="7.5" cy="2.5" r="1.5" />
      <circle cx="2.5" cy="8" r="1.5" />
      <circle cx="7.5" cy="8" r="1.5" />
      <circle cx="2.5" cy="13.5" r="1.5" />
      <circle cx="7.5" cy="13.5" r="1.5" />
    </svg>
  );
}

interface ProjectSubItemsProps {
  item: { subItems?: EntrySubItem[] };
  itemIndex: number;
  onChange: (patch: { subItems?: EntrySubItem[] }) => void;
  onAnnouncement: (message: string) => void;
  presetLabels?: string[];
  helpText?: string;
  defaultSubLabel?: string;
}

export function ProjectSubItems({
  item,
  itemIndex,
  onChange,
  onAnnouncement,
  presetLabels = DEFAULT_PRESET_SUB_LABELS,
  helpText = "如技术栈、链接、成果指标",
  defaultSubLabel = "技术栈",
}: ProjectSubItemsProps) {
  const [armedSub, setArmedSub] = useState<number | null>(null);
  const [dragSub, setDragSub] = useState<number | null>(null);
  const subList = item.subItems ?? [];

  function addSubItem(label = defaultSubLabel) {
    const subItems: EntrySubItem[] = [...subList, { id: genEntryId("sub"), label, value: "" }];
    onChange({ subItems });
  }

  function updateSubItem(subIndex: number, key: "label" | "value", value: string) {
    onChange({ subItems: subList.map((sub, index) => index === subIndex ? { ...sub, [key]: value } : sub) });
  }

  function removeSubItem(subIndex: number) {
    onChange({ subItems: subList.filter((_, index) => index !== subIndex) });
  }

  function reorderSubItem(from: number, to: number) {
    if (from === to) return;
    const subItems = [...subList];
    const [moved] = subItems.splice(from, 1);
    if (moved === undefined) return;
    subItems.splice(to, 0, moved);
    onChange({ subItems });
  }

  function moveSubItem(subIndex: number, delta: -1 | 1) {
    const to = subIndex + delta;
    if (to < 0 || to >= subList.length) return;
    reorderSubItem(subIndex, to);
    onAnnouncement(`副项已移到第 ${to + 1} 位`);
  }

  return (
    <div className="mt-5 rounded-xl border border-line/80 bg-surface/40 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">自定义副项（自由排序）</span>
          <span className="text-[11px] text-muted">{helpText}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {presetLabels.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => addSubItem(preset)}
              className={`${badgeCls} transition-colors hover:border-primary/40 hover:text-primary cursor-pointer`}
              title={`快速新增「${preset}」副项`}
            >
              + {preset}
            </button>
          ))}
          <button
            type="button"
            onClick={() => addSubItem("")}
            className="text-xs font-medium text-primary hover:underline ml-1"
          >
            + 自定义副项
          </button>
        </div>
      </div>

      {subList.length === 0 ? (
        <div className="text-xs text-faint py-1.5">
          暂无副项。可点击上方按钮添加相关信息，将在标题下方清晰整齐呈现。
        </div>
      ) : (
        <div className="space-y-2">
          {subList.map((sub, subIndex) => (
            <div
              key={sub.id ?? subIndex}
              draggable={armedSub === subIndex}
              onDragStart={(event) => {
                event.stopPropagation();
                setDragSub(subIndex);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", `sub:${itemIndex}:${subIndex}`);
              }}
              onDragEnd={() => {
                setDragSub(null);
                setArmedSub(null);
              }}
              onDragOver={(event) => {
                if (dragSub === null || dragSub === subIndex) return;
                event.preventDefault();
                event.stopPropagation();
                reorderSubItem(dragSub, subIndex);
                setDragSub(subIndex);
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              className={`flex flex-col gap-2 rounded-lg border border-line bg-card p-2.5 shadow-2xs transition-all ${
                dragSub === subIndex ? "opacity-30 scale-[0.99]" : "hover:border-line-strong"
              }`}
            >
              {/* 第一行：Key 标签名与顺序调整、删除操作 */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <button
                    type="button"
                    title="拖动调整副项顺序"
                    className="cursor-grab text-muted transition-colors hover:text-primary active:cursor-grabbing p-0.5 rounded hover:bg-surface shrink-0"
                    onMouseDown={() => setArmedSub(subIndex)}
                    onMouseUp={() => setArmedSub(null)}
                  >
                    <GripIcon />
                  </button>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      title="上移副项"
                      disabled={subIndex === 0}
                      onClick={() => moveSubItem(subIndex, -1)}
                      className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="下移副项"
                      disabled={subIndex === subList.length - 1}
                      onClick={() => moveSubItem(subIndex, 1)}
                      className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                    >
                      ↓
                    </button>
                  </div>
                  <input
                    className={`${inputCls} w-36 sm:w-48 shrink-0 !py-1 text-xs font-medium`}
                    value={sub.label}
                    onChange={(event) => updateSubItem(subIndex, "label", event.target.value)}
                    placeholder="标签名"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeSubItem(subIndex)}
                  title="删除此副项"
                  className="text-xs text-muted hover:text-danger p-1 rounded transition-colors shrink-0"
                >
                  ×
                </button>
              </div>

              {/* 第二行：Value 内容自适应整行与换行 */}
              <AutoResizeTextarea
                className={`${inputCls} w-full !py-1.5 text-xs leading-relaxed break-words`}
                value={sub.value}
                onChange={(event) => updateSubItem(subIndex, "value", event.target.value)}
                placeholder="内容，如：React 19, TypeScript, Tailwind CSS"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
