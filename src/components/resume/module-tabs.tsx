"use client";

import { useEffect, useRef, useState } from "react";
import { MODULE_KEYS, MODULE_LABELS, type ModuleData, type ModuleKey } from "@/lib/modules";
import { btnGhost, btnPrimary, inputCls, labelCls, textErr } from "@/lib/ui";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { errorMessage } from "@/lib/error-message";

/** 各结构类型适合放什么内容，供添加模块时选择参考 */
const TYPE_HINTS: Record<ModuleKey, string> = {
  basic: "姓名与联系方式（第一个会作为简历页眉）",
  education: "学校、学位、专业、起止时间等条目列表",
  work: "公司、职位、起止时间等条目列表",
  projects: "项目名称、角色、起止时间等条目列表",
  skills: "技能标签列表",
  summary: "一段完整的描述文本",
  custom: "自定义多项条目列表（支持主要名称、补充说明、时间、副项键值对与描述）",
};

/** 简历模块标签条：点击切换、拖拽排序、双击重命名、× 删除，末尾是「添加模块」按钮 */
export function ModuleTabs({
  modules,
  activeKey,
  onSelect,
  onReorder,
  onOrderCommit,
  onDelete,
  onRename,
  onAdd,
}: {
  modules: ModuleData[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** 拖拽过程中的实时预览排序（仅本地状态） */
  onReorder: (dragKey: string, toIndex: number) => void;
  /** 拖拽结束时提交最终顺序 */
  onOrderCommit: (orderedKeys: string[]) => void;
  onDelete: (key: string) => void;
  onRename: (key: string, label: string) => Promise<void>;
  onAdd: () => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingKey) inputRef.current?.select();
  }, [editingKey]);

  /** 拖拽之外的键盘等价操作：把某个模块前移/后移一位，并播报结果 */
  function move(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= modules.length) return;
    const next = [...modules];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onOrderCommit(next.map((x) => x.key));
    setAnnouncement(`模块「${moved.label}」已移到第 ${to + 1} 位，共 ${modules.length} 个模块`);
  }

  function startRename(m: ModuleData) {
    setEditingKey(m.key);
    setRenameDraft(m.label);
  }

  async function commitRename() {
    const key = editingKey;
    setEditingKey(null);
    if (!key) return;
    const next = renameDraft.trim();
    const current = modules.find((m) => m.key === key);
    if (!current || !next || next === current.label) return;
    await onRename(key, next);
  }

  return (
    <>
      <div
        role="tablist"
        className="mt-4 flex flex-wrap items-center gap-1.5 border-b border-line pb-2.5"
      >
        {modules.map((m, index) => {
          const active = m.key === activeKey;
          const editing = m.key === editingKey;
          return (
            <div
              key={m.key}
              // 中间层用 presentation 移除语义节点，使 tab 与 tablist 保持直接父子关系，
              // 同时允许同一行内放置重命名输入框与排序/删除按钮。
              role="presentation"
              draggable={editingKey !== m.key}
              onDragStart={(e) => {
                setDragKey(m.key);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", m.key);
              }}
              onDragEnd={() => {
                setDragKey(null);
                onOrderCommit(modules.map((x) => x.key));
              }}
              onDragOver={(e) => {
                if (!dragKey || dragKey === m.key) return;
                e.preventDefault();
                onReorder(dragKey, index);
              }}
              onDrop={(e) => e.preventDefault()}
              className={`group flex items-center rounded-lg border text-sm transition-all ${
                active
                  ? "border-primary bg-primary-soft/40 text-ink font-semibold shadow-xs"
                  : "border-line bg-card/60 text-muted hover:border-line-strong hover:bg-surface hover:text-ink"
              } ${dragKey === m.key ? "opacity-40" : ""}`}
            >
              {editing ? (
                <input
                  ref={inputRef}
                  className="w-28 rounded border border-primary px-2 py-1 text-sm outline-none bg-card text-ink"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditingKey(null);
                  }}
                  aria-label="模块重命名"
                />
              ) : (
                <button
                  role="tab"
                  aria-selected={active}
                  title="点击切换；拖动或用 ↑↓ 调整顺序；双击重命名"
                  onClick={() => onSelect(m.key)}
                  onDoubleClick={() => startRename(m)}
                  className={`px-3 py-1.5 text-sm transition-colors ${
                    active ? "text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {m.label}
                </button>
              )}
              <button
                type="button"
                aria-label={`将模块「${m.label}」前移`}
                title="前移"
                disabled={index === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  move(index, -1);
                }}
                className={`flex h-5 w-5 items-center justify-center rounded text-xs text-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-80 disabled:hidden ${
                  editing ? "hidden" : ""
                }`}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`将模块「${m.label}」后移`}
                title="后移"
                disabled={index === modules.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  move(index, 1);
                }}
                className={`flex h-5 w-5 items-center justify-center rounded text-xs text-faint opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover:opacity-80 disabled:hidden ${
                  editing ? "hidden" : ""
                }`}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`删除模块「${m.label}」`}
                title="删除模块"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(m.key);
                }}
                className={`mr-1.5 flex h-5 w-5 items-center justify-center rounded text-xs text-faint transition-colors hover:bg-danger-wash hover:text-danger ${
                  active ? "opacity-80 hover:opacity-100" : "opacity-0 group-hover:opacity-80 hover:!opacity-100"
                } ${editing ? "hidden" : ""}`}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          className="rounded-lg border border-dashed border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-primary hover:text-primary hover:bg-primary-soft/20"
        >
          + 添加模块
        </button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}

/** 添加模块弹窗：从模板结构中选择或自定义命名，模块名称在简历内需唯一 */
export function AddModuleDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  /** 提交添加请求；失败时抛出错误信息显示在弹窗内 */
  onSubmit: (label: string, type: ModuleKey) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ModuleKey | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useModalFocus(open, close, "input");

  function reset() {
    setName("");
    setType(null);
    setNameTouched(false);
    setError("");
    setSubmitting(false);
  }

  if (!open) return null;

  function close() {
    reset();
    onClose();
  }

  function pickType(next: ModuleKey) {
    setType(next);
    // 名称尚未手动输入时跟随所选模板结构的默认名，用户可继续自定义
    if (!nameTouched) setName(MODULE_LABELS[next]);
  }

  async function submit() {
    if (!type || !name.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(name.trim(), type);
      reset();
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="添加模块"
      className="overlay-in fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]"
      onClick={close}
    >
      <div
        className="dialog-in w-full max-w-md rounded-2xl border border-line bg-card p-6 shadow-card-float"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-base font-bold text-ink">添加模块</h2>
        <p className="mt-1.5 text-sm text-muted">
          选择一个模板模块，或为它自定义名称；模块名称在同一份简历内需唯一。
        </p>

        <label className="mt-4 block">
          <span className={labelCls}>模块名称</span>
          <input
            className={`${inputCls} mt-1`}
            value={name}
            maxLength={50}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
            placeholder="如：实习经历、获奖情况"
          />
        </label>

        <div className="mt-4">
          <span className={labelCls}>内容结构</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {MODULE_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => pickType(k)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  type === k
                    ? "bg-primary text-on-primary"
                    : "border border-line text-muted hover:bg-surface hover:text-ink"
                }`}
              >
                {MODULE_LABELS[k]}
              </button>
            ))}
          </div>
          {type && <p className="mt-2 text-xs text-faint">{TYPE_HINTS[type]}</p>}
        </div>

        {error && <p className={`mt-3 text-sm ${textErr}`}>{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button className={btnGhost} onClick={close} disabled={submitting}>
            取消
          </button>
          <button className={btnPrimary} onClick={submit} disabled={!type || !name.trim() || submitting}>
            {submitting ? "添加中…" : "添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
