"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { btnDanger, btnGhost, inputCls, textareaCls, labelCls } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { apiFetch } from "@/lib/api-fetch";
import { AvatarCropperModal } from "@/components/resume/avatar-cropper-modal";
import { RichTextEditor } from "@/components/resume/rich-text-editor";
import { Field, SaveBar } from "./module-editor-shared";
import type { ChangeOptions, Status } from "./module-editor-shared";
import { getOrderedBasicKeys, type BasicReorderableFieldKey, type DescriptionListStyle } from "@/lib/modules";
import { GripIcon } from "./project-sub-items";
import { splitRichTextToLines } from "@/lib/rich-text";

const REORDERABLE_FIELD_DEFS: Record<BasicReorderableFieldKey, { label: string; placeholder?: string; textarea?: boolean }> = {
  gender: { label: "性别", placeholder: "例如：男 / 女" },
  age: { label: "年龄", placeholder: "例如：25岁" },
  birthday: { label: "出生年月", placeholder: "例如：1998-05" },
  phone: { label: "电话", placeholder: "例如：138-0000-0000" },
  email: { label: "邮箱", placeholder: "例如：example@mail.com" },
  location: { label: "所在地", placeholder: "例如：北京 / 杭州" },
  links: { label: "链接", placeholder: "GitHub / 主页 / 博客，换行分隔", textarea: true },
};

export function BasicEditor({
  content,
  onChange,
  status,
  onProofingFieldFocus,
}: {
  content: Record<string, unknown>;
  onChange: (c: Record<string, unknown>, opts?: ChangeOptions) => void;
  status: Status;
  onProofingFieldFocus?: (id: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [cropImageSrc, setCropImageSrc] = useState("");
  const cropObjectUrlsRef = useRef(new Set<string>());
  const latestRef = useRef({ content, onChange });
  const uploadStateRef = useRef({ sequence: 0 });

  useLayoutEffect(() => {
    latestRef.current = { content, onChange };
  }, [content, onChange]);

  useEffect(() => {
    for (const url of cropObjectUrlsRef.current) {
      if (!cropModalOpen || url !== cropImageSrc) {
        URL.revokeObjectURL(url);
        cropObjectUrlsRef.current.delete(url);
      }
    }
  }, [cropModalOpen, cropImageSrc]);

  useEffect(() => {
    const urls = cropObjectUrlsRef.current;
    const uploads = uploadStateRef.current;
    return () => {
      uploads.sequence++;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const [dragField, setDragField] = useState<string | null>(null);
  const [armedField, setArmedField] = useState<string | null>(null);

  const currentOrder: BasicReorderableFieldKey[] = getOrderedBasicKeys(content.fieldOrder);

  function reorderField(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    const newOrder = [...currentOrder];
    const [moved] = newOrder.splice(fromIndex, 1);
    if (!moved) return;
    newOrder.splice(toIndex, 0, moved);
    onChange({ ...content, fieldOrder: newOrder });
  }

  function moveField(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= currentOrder.length) return;
    reorderField(index, target);
  }

  const avatar = typeof content.avatar === "string" ? content.avatar : "";
  const avatarSize = typeof content.avatarSize === "number" ? content.avatarSize : 72;
  const avatarShape = (content.avatarShape as string) || "rounded";
  const avatarX = typeof content.avatarX === "number" ? content.avatarX : 0;
  const avatarY = typeof content.avatarY === "number" ? content.avatarY : 0;
  const isCircle = avatarShape === "circle";
  const avatarHeight = isCircle ? avatarSize : Math.round((avatarSize * 4) / 3);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError("");
    const url = URL.createObjectURL(file);
    cropObjectUrlsRef.current.add(url);
    setCropImageSrc(url);
    setCropModalOpen(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleReCrop() {
    if (!avatar) return;
    setCropImageSrc(avatar);
    setCropModalOpen(true);
  }

  async function handleCropComplete(file: File) {
    const sequence = ++uploadStateRef.current.sequence;
    setUploadError("");
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiFetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (sequence !== uploadStateRef.current.sequence) return;
      if (!res.ok || !data.url) {
        throw new Error(data.error || "头像上传失败");
      }
      latestRef.current.onChange(
        {
          ...latestRef.current.content,
          avatar: data.url,
          avatarX: 0,
          avatarY: 0,
        },
        { immediate: true }
      );
    } catch (err) {
      if (sequence === uploadStateRef.current.sequence) setUploadError(errorMessage(err));
    } finally {
      if (sequence === uploadStateRef.current.sequence) setUploading(false);
    }
  }

  function removeAvatar() {
    onChange(
      {
        ...content,
        avatar: "",
        avatarX: 0,
        avatarY: 0,
      },
      { immediate: true }
    );
  }

  function resetOffset() {
    onChange(
      {
        ...content,
        avatarX: 0,
        avatarY: 0,
      },
      { immediate: true }
    );
  }

  return (
    <div data-edit-card-index={0} className="space-y-4">
      {/* 证件照裁剪与缩放弹窗 */}
      <AvatarCropperModal
        open={cropModalOpen}
        imageSrc={cropImageSrc}
        onClose={() => {
          setCropModalOpen(false);
          setCropImageSrc("");
        }}
        onCropComplete={handleCropComplete}
      />

      {/* 个人头像配置卡片 */}
      <div className="rounded-xl border border-line bg-surface/60 p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-ink">个人头像（标准寸照）</span>
          {avatar && (
            <span className="text-xs text-muted">
              微调偏移: ({avatarX}, {avatarY}) px
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          {avatar ? (
            <div
              className="relative shrink-0 overflow-hidden border border-line bg-card shadow-sm"
              style={{
                width: 54,
                height: isCircle ? 54 : 72,
                borderRadius: isCircle ? "50%" : avatarShape === "rounded" ? "6px" : "2px",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={avatar} alt="头像缩略图" className="h-full w-full object-cover" />
            </div>
          ) : (
            <div className="flex h-[72px] w-[54px] shrink-0 items-center justify-center rounded border border-dashed border-line-strong bg-surface text-[11px] text-muted text-center px-1">
              暂无寸照
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={handleFileSelect}
            />
            <button
              type="button"
              className={btnGhost}
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "上传中…" : avatar ? "更换照片" : "上传寸照"}
            </button>
            {avatar && (
              <>
                <button
                  type="button"
                  className={btnGhost}
                  disabled={uploading}
                  onClick={handleReCrop}
                  title="重新缩放与调整裁剪区域"
                >
                  裁剪缩放
                </button>
                <button
                  type="button"
                  className={btnGhost}
                  onClick={resetOffset}
                  title="恢复头像居中/默认位置"
                >
                  重置位置
                </button>
                <button
                  type="button"
                  className={btnDanger}
                  disabled={uploading}
                  onClick={removeAvatar}
                >
                  移除
                </button>
              </>
            )}
          </div>
        </div>

        {uploadError && <p className="text-xs text-danger">{uploadError}</p>}

        {avatar && (
          <div className="space-y-3 pt-2 border-t border-line/60">
            {/* 形状选择 */}
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <span className="text-muted">样式：</span>
              {(
                [
                  { key: "rounded", label: "圆角寸照 (3:4)" },
                  { key: "square", label: "标准寸照 (3:4)" },
                  { key: "circle", label: "圆形头像 (1:1)" },
                ] as const
              ).map((shape) => (
                <label key={shape.key} className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="avatarShape"
                    checked={avatarShape === shape.key}
                    onChange={() => onChange({ ...content, avatarShape: shape.key }, { immediate: true })}
                    className="accent-primary"
                  />
                  <span>{shape.label}</span>
                </label>
              ))}
            </div>

            {/* 尺寸滑块 */}
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted shrink-0">尺寸：</span>
              <input
                type="range"
                min="56"
                max="105"
                step="2"
                value={avatarSize}
                onChange={(e) =>
                  onChange({ ...content, avatarSize: Number(e.target.value) }, { immediate: false })
                }
                className="w-40 accent-primary cursor-pointer"
              />
              <span className="font-mono text-muted">
                {isCircle ? `${avatarSize}px` : `宽 ${avatarSize} × 高 ${avatarHeight} px`}
              </span>
            </div>

            <p className="text-[11px] text-muted leading-normal">
              💡 提示：在右侧纸面上按住寸照可自由向左/上下微调，已限制<strong>无法拖出右侧边界</strong>与页眉区域。
            </p>
          </div>
        )}
      </div>

      {/* 姓名主字段：固定顶部 */}
      <Field
        fieldKey="name"
        label="姓名"
        value={typeof content.name === "string" ? (content.name as string) : ""}
        onChange={(v) => onChange({ ...content, name: v })}
        onFocus={() => onProofingFieldFocus?.("basic.name")}
        placeholder="例如：林知遥"
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted px-0.5">
          <span className="font-semibold text-ink flex items-center gap-1.5">
            <span aria-hidden="true">📋</span>
            <span>其他基本信息（按住抓手拖拽可自定义展示顺序）</span>
          </span>
          <span className="text-[11px] text-muted">决定页眉与导出中的排列顺序</span>
        </div>
        <div className="space-y-2">
          {currentOrder.map((key, index) => {
            const f = REORDERABLE_FIELD_DEFS[key];
            if (!f) return null;
            const isDragging = dragField === key;
            const val = typeof content[key] === "string" ? (content[key] as string) : "";
            return (
              <div
                key={key}
                data-edit-field={key}
                draggable={armedField === key}
                onDragStart={(e) => {
                  e.stopPropagation();
                  setDragField(key);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", `basic-field:${key}`);
                }}
                onDragEnd={() => {
                  setDragField(null);
                  setArmedField(null);
                }}
                onDragOver={(e) => {
                  if (!dragField || dragField === key) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const fromIdx = currentOrder.indexOf(dragField as BasicReorderableFieldKey);
                  const toIdx = index;
                  if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                    reorderField(fromIdx, toIdx);
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className={`rounded-lg border border-line bg-card p-2.5 shadow-2xs transition-all ${
                  isDragging ? "opacity-30 scale-[0.99] border-primary/50" : "hover:border-line-strong"
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onPointerDown={() => setArmedField(key)}
                      onPointerUp={() => setArmedField(null)}
                      className="cursor-grab active:cursor-grabbing p-1 text-muted hover:text-ink rounded transition-colors"
                      title="按住拖拽排序"
                      aria-label={`拖拽排序 ${f.label}`}
                    >
                      <GripIcon />
                    </button>
                    <span className={labelCls}>{f.label}</span>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveField(index, -1)}
                      className="px-1.5 py-0.5 text-xs text-muted hover:text-ink hover:bg-surface rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                      title="上移"
                      aria-label={`上移 ${f.label}`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === currentOrder.length - 1}
                      onClick={() => moveField(index, 1)}
                      className="px-1.5 py-0.5 text-xs text-muted hover:text-ink hover:bg-surface rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                      title="下移"
                      aria-label={`下移 ${f.label}`}
                    >
                      ↓
                    </button>
                  </div>
                </div>
                {f.textarea ? (
                  <textarea
                    aria-label={f.label}
                    value={val}
                    onChange={(e) => onChange({ ...content, [key]: e.target.value })}
                    onFocus={() => onProofingFieldFocus?.(`basic.${key}`)}
                    placeholder={f.placeholder}
                    rows={2}
                    className={textareaCls}
                  />
                ) : (
                  <input
                    aria-label={f.label}
                    type="text"
                    value={val}
                    onChange={(e) => onChange({ ...content, [key]: e.target.value })}
                    onFocus={() => onProofingFieldFocus?.(`basic.${key}`)}
                    placeholder={f.placeholder}
                    className={inputCls}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <SaveBar status={status} />
    </div>
  );
}

export function SkillsEditor({
  content,
  onChange,
  status,
}: {
  content: { items: string[] };
  onChange: (c: { items: string[] }, opts?: ChangeOptions) => void;
  status: Status;
}) {
  const [input, setInput] = useState("");

  function addItem() {
    const value = input.trim();
    if (!value || content.items.includes(value)) return;
    onChange({ items: [...content.items, value] }, { immediate: true });
    setInput("");
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {content.items.map((item, index) => (
          <span
            key={item}
            data-edit-card-index={index}
            className="flex items-center gap-1.5 rounded-full border border-line bg-surface pl-3 pr-1.5 py-1 text-sm transition-all"
          >
            <span>{item}</span>
            <button
              className="flex h-5 w-5 items-center justify-center rounded-full text-faint transition-colors hover:bg-danger-wash hover:text-danger"
              onClick={() =>
                onChange(
                  { items: content.items.filter((v) => v !== item) },
                  { immediate: true }
                )
              }
              aria-label={`删除 ${item}`}
            >
              ×
            </button>
          </span>
        ))}
        {content.items.length === 0 && <p className="text-sm text-muted">暂无技能，添加后保存。</p>}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          className={`${inputCls} flex-1 min-w-0 sm:max-w-xs`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addItem())}
          placeholder="输入技能后回车添加"
        />
        <button className={btnGhost} onClick={addItem}>
          添加
        </button>
      </div>
      <SaveBar status={status} />
    </div>
  );
}

export type SummaryActionsCtx = {
  text: string;
  items?: string[];
  descriptionStyle?: DescriptionListStyle;
  updateText: (text: string, items?: string[], mode?: "replace" | "append") => void;
};

export function SummaryEditor({
  content,
  onChange,
  status,
  renderActions,
}: {
  content: { text: string; descriptionItems?: string[]; descriptionStyle?: DescriptionListStyle };
  onChange: (c: { text: string; descriptionItems?: string[]; descriptionStyle?: DescriptionListStyle }, opts?: ChangeOptions) => void;
  status: Status;
  renderActions?: (ctx: SummaryActionsCtx) => React.ReactNode;
}) {
  const [dragDesc, setDragDesc] = useState<number | null>(null);
  const [armedDesc, setArmedDesc] = useState<number | null>(null);

  const descStyle: DescriptionListStyle = content.descriptionStyle ?? "unordered";
  const descList =
    Array.isArray(content.descriptionItems) && content.descriptionItems.length > 0
      ? content.descriptionItems
      : content.text
        ? splitRichTextToLines(content.text)
        : [""];

  function updateItems(nextItems: string[], nextStyle?: DescriptionListStyle) {
    const finalStyle = nextStyle ?? descStyle;
    const filtered = nextItems.map((s) => s.trim()).filter(Boolean);
    const text = filtered.length > 0 ? filtered.join("\n") : nextItems.join("\n");
    onChange({
      text,
      descriptionItems: nextItems,
      descriptionStyle: finalStyle,
    });
  }

  function updateItemAt(index: number, val: string) {
    const next = [...descList];
    next[index] = val;
    updateItems(next);
  }

  function removeItemAt(index: number) {
    const next = descList.filter((_, i) => i !== index);
    updateItems(next.length > 0 ? next : [""]);
  }

  function addItem() {
    updateItems([...descList, ""]);
  }

  function moveItem(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= descList.length) return;
    const next = [...descList];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    updateItems(next);
  }

  function reorderItem(from: number, to: number) {
    if (from === to) return;
    const next = [...descList];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    updateItems(next);
  }

  function handleApplyText(newText: string, newItems?: string[], mode?: "replace" | "append") {
    const finalItems = newItems && newItems.length > 0 ? newItems : splitRichTextToLines(newText);
    if (mode === "append") {
      const existing = descList.filter((s) => s.trim().length > 0);
      const combined = [...existing, ...finalItems];
      const finalCombined = combined.length > 0 ? combined : [""];
      onChange(
        {
          text: finalCombined.join("\n"),
          descriptionItems: finalCombined,
          descriptionStyle: descStyle,
        },
        { immediate: true }
      );
    } else {
      const nextItems = finalItems.length > 0 ? finalItems : [""];
      onChange(
        {
          text: nextItems.join("\n"),
          descriptionItems: nextItems,
          descriptionStyle: descStyle,
        },
        { immediate: true }
      );
    }
  }

  return (
    <div data-edit-card-index={0} className="space-y-4">
      <div className="rounded-xl border border-line/80 bg-surface/40 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink">自我评价要点</span>
            <span className="text-[11px] text-muted">支持分行拖拽排版</span>
          </div>

          {/* 有序 / 无序列表风格切换分段器 */}
          <div className="inline-flex rounded-lg border border-line bg-card p-0.5 text-xs">
            <button
              type="button"
              onClick={() => updateItems(descList, "unordered")}
              className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                descStyle === "unordered"
                  ? "bg-primary text-on-primary shadow-2xs font-semibold"
                  : "text-muted hover:text-ink"
              }`}
            >
              • 无序列表
            </button>
            <button
              type="button"
              onClick={() => updateItems(descList, "ordered")}
              className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                descStyle === "ordered"
                  ? "bg-primary text-on-primary shadow-2xs font-semibold"
                  : "text-muted hover:text-ink"
              }`}
            >
              1. 有序列表
            </button>
          </div>
        </div>

        <div className="space-y-2.5">
          {descList.map((desc, descIndex) => {
            const isDraggingThisDesc = dragDesc === descIndex;
            const isArmedThisDesc = armedDesc === descIndex;

            return (
              <div
                key={descIndex}
                draggable={isArmedThisDesc}
                onDragStart={(e) => {
                  e.stopPropagation();
                  setDragDesc(descIndex);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", `summary-desc:${descIndex}`);
                }}
                onDragEnd={() => {
                  setDragDesc(null);
                  setArmedDesc(null);
                }}
                onDragOver={(e) => {
                  if (dragDesc === null || dragDesc === descIndex) return;
                  e.preventDefault();
                  e.stopPropagation();
                  reorderItem(dragDesc, descIndex);
                  setDragDesc(descIndex);
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
                    onMouseDown={() => setArmedDesc(descIndex)}
                    onMouseUp={() => setArmedDesc(null)}
                  >
                    <GripIcon />
                  </button>
                  <span className="font-mono text-xs font-bold text-primary">
                    {descStyle === "ordered" ? `${descIndex + 1}.` : "•"}
                  </span>
                </div>

                <div className="flex flex-col gap-1 shrink-0 pt-0.5">
                  <button
                    type="button"
                    title="上移此行"
                    disabled={descIndex === 0}
                    onClick={() => moveItem(descIndex, -1)}
                    className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="下移此行"
                    disabled={descIndex === descList.length - 1}
                    onClick={() => moveItem(descIndex, 1)}
                    className="rounded p-0.5 text-xs text-muted hover:bg-surface hover:text-primary disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>

                <div className="flex-1 min-w-0">
                  <RichTextEditor
                    value={desc}
                    onChange={(val) => updateItemAt(descIndex, val)}
                    placeholder="自我评价要点（建议体现核心技术栈/工程深度/业务攻坚等）…"
                    minHeightClass="min-h-[72px]"
                    ariaLabel={`自我评价第 ${descIndex + 1} 行`}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => removeItemAt(descIndex)}
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
            onClick={addItem}
            className="text-xs font-medium text-primary hover:underline"
          >
            + 添加一行评价
          </button>
          <span className="text-[11px] text-faint">每行支持独立上下拖动调序</span>
        </div>
      </div>

      {renderActions && (
        <div className="flex gap-2">
          {renderActions({
            text: content.text,
            items: descList,
            descriptionStyle: descStyle,
            updateText: handleApplyText,
          })}
        </div>
      )}

      <SaveBar status={status} />
    </div>
  );
}
