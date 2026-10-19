"use client";

import { useState } from "react";
import { btnGhost } from "@/lib/ui";
import { Field, SaveBar } from "./module-editor-shared";
import type { ChangeOptions, FieldCfg, ItemActionsCtx, ItemDraft, Status } from "./module-editor-shared";

export { SaveBar } from "./module-editor-shared";
export type { Status, ChangeOptions, ItemDraft, FieldCfg, ItemActionsCtx } from "./module-editor-shared";
export { BasicEditor, SkillsEditor, SummaryEditor } from "./module-content-editors";
export type { SummaryActionsCtx } from "./module-content-editors";

function GripIcon() {
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

/** 受控列表编辑器：值由父级持有，输入即回调，父级可实时渲染预览 */
export function ListEditor({
  fields,
  itemName,
  items,
  onChange,
  status,
  renderItemActions,
  onProofingFieldFocus,
}: {
  fields: FieldCfg[];
  itemName: string;
  items: ItemDraft[];
  onChange: (items: ItemDraft[], opts?: ChangeOptions) => void;
  status: Status;
  renderItemActions?: (ctx: ItemActionsCtx) => React.ReactNode;
  onProofingFieldFocus?: (index: number, key: string) => void;
}) {
  // armedIndex：按下把手后才允许拖动，避免卡片内选中文本误触发拖拽
  const [armedIndex, setArmedIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function update(index: number, key: string, value: string) {
    onChange(items.map((it, i) => (i === index ? { ...it, [key]: value } : it)));
  }

  function add() {
    const blank: ItemDraft = { id: `new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` };
    for (const f of fields) blank[f.key] = "";
    onChange([...items, blank], { immediate: true });
  }

  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onChange(next, { immediate: true });
  }

  /** 拖拽之外的键盘等价操作：把某一条前移/后移一位，并播报结果 */
  function move(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    reorder(index, to);
    setAnnouncement(`第 ${index + 1} 条${itemName}已移到第 ${to + 1} 位，共 ${items.length} 条`);
  }

  return (
    <div className="space-y-4">
      {items.length === 0 && (
        <p className="text-sm text-muted">暂无内容，点击下方按钮添加一条{itemName}。</p>
      )}
      {items.map((item, index) => (
        <div
          key={item.id ?? index}
          draggable={armedIndex === index}
          onDragStart={(e) => {
            setDragIndex(index);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(index));
          }}
          onDragEnd={() => {
            setDragIndex(null);
            setArmedIndex(null);
          }}
          onDragOver={(e) => {
            if (dragIndex === null || dragIndex === index) return;
            e.preventDefault();
            reorder(dragIndex, index);
            setDragIndex(index);
          }}
          onDrop={(e) => e.preventDefault()}
          data-edit-card-index={index}
          className={`rounded-2xl border border-line bg-card p-5 shadow-card-subtle transition-all ${
            dragIndex === index ? "opacity-40 scale-[0.99]" : "hover:border-line-strong"
          }`}
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                title="拖动排序"
                aria-label={`拖动调整第 ${index + 1} 条${itemName}的顺序`}
                className="cursor-grab text-muted transition-colors hover:text-primary active:cursor-grabbing p-1 -ml-1 rounded hover:bg-surface"
                onMouseDown={() => setArmedIndex(index)}
                onMouseUp={() => setArmedIndex(null)}
              >
                <GripIcon />
              </button>
              <span className="font-mono text-xs font-semibold text-faint">#{index + 1}</span>
              <button
                type="button"
                title="上移"
                aria-label={`将第 ${index + 1} 条${itemName}上移`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-primary disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                title="下移"
                aria-label={`将第 ${index + 1} 条${itemName}下移`}
                disabled={index === items.length - 1}
                onClick={() => move(index, 1)}
                className="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-primary disabled:opacity-30"
              >
                ↓
              </button>
            </div>
            <span className="text-[11px] text-faint font-medium">可拖拽重排，或用 ↑↓</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {fields.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                value={item[f.key] ?? ""}
                onChange={(v) => update(index, f.key, v)}
                onFocus={() => onProofingFieldFocus?.(index, f.key)}
                textarea={f.textarea}
                richText={f.richText}
                wide={f.wide}
                placeholder={f.placeholder}
              />
            ))}
          </div>
          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            {renderItemActions?.({
              item,
              updateItem: (patch) =>
                onChange(
                  items.map((it, i) => (i === index ? ({ ...it, ...patch } as ItemDraft) : it)),
                  { immediate: true }
                ),
            })}
            <button
              className={`${btnGhost} text-danger`}
              onClick={() => onChange(items.filter((_, i) => i !== index), { immediate: true })}
            >
              删除本条
            </button>
          </div>
        </div>
      ))}
      <button className={btnGhost} onClick={add}>
        + 添加{itemName}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <SaveBar status={status} />
    </div>
  );
}

