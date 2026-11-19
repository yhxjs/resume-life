"use client";

/** 错题本共享件：收藏星标按钮（练习/面试详情页共用）与分类弹窗（选择 / 管理） */

import { useRef, useState } from "react";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { CompactModal } from "@/components/common/modal-variants";
import { btnGhost, btnPrimary, inputCls, textErr } from "@/lib/ui";
import type { ReviewLink } from "@/lib/spaced-repetition-card-types";
import { useNotebookDeletion } from "@/hooks/use-notebook-deletion";
import { useNotebookCategories } from "@/hooks/use-notebook-categories";
import { useNotebookCategoryCommand } from "@/hooks/use-notebook-category-command";
import { useNotebookFavorite } from "@/hooks/use-notebook-favorite";
import type { NotebookCategory } from "@/lib/notebook-records";

export type { NotebookCategory } from "@/lib/notebook-records";

/** 弹窗外壳：遮罩 + 卡片，与 confirm-dialog 同一视觉词汇 */
function NotebookDialog({
  title,
  onClose,
  dismissDisabled = false,
  children,
}: {
  title: string;
  onClose: () => void;
  dismissDisabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <CompactModal
      open
      title={title}
      onClose={onClose}
      closeOnBackdrop={!dismissDisabled}
      escapeDisabled={dismissDisabled}
    >
      <h2 className="font-serif text-base font-bold text-ink">{title}</h2>
      {children}
    </CompactModal>
  );
}

function categoryChipCls(active: boolean): string {
  return `max-w-full rounded-2xl border px-3 py-1 text-left text-xs [overflow-wrap:anywhere] transition-colors disabled:opacity-50 ${
    active
      ? "border-primary/40 bg-primary-soft font-medium text-primary"
      : "border-line text-muted hover:bg-surface"
  }`;
}

function CategoryCommandFeedback({ command }: { command: ReturnType<typeof useNotebookCategoryCommand> }) {
  return <div className="space-y-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
    {command.error && <p role="alert" className={textErr}>{command.error}</p>}
    {command.notice && <p role="status" className="text-primary">{command.notice}</p>}
    {command.busy && command.phase !== "unknown" && <p role="status" className="text-muted">{command.phase === "confirming" ? "等待确认分类操作…" : command.phase === "checking" ? "正在只读核对分类状态…" : "正在保存分类操作…"}</p>}
    {(command.phase === "unknown" || command.phase === "checking") && <button type="button" className={btnPrimary} disabled={command.phase === "checking"} onClick={command.reread}>重新读取分类状态</button>}
  </div>;
}

/** 分类单选 + 行内新建分类；value 为 null 表示未分类 */
function CategoryPicker({
  value,
  onChange,
  disabled = false,
  onBusyChange,
  canMutate,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  onBusyChange: (locked: boolean) => void;
  canMutate: () => boolean;
}) {
  const { categories, error: categoriesError, reload } = useNotebookCategories();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [createdCategory, setCreatedCategory] = useState<Pick<NotebookCategory, "id" | "name"> | null>(null);
  const command = useNotebookCategoryCommand((_input, created) => {
    if (created) {
      setCreatedCategory(created);
      onChange(created.id);
      setName("");
      setCreating(false);
      reload();
    }
  }, onBusyChange);
  const busy = disabled || command.busy;
  function select(id: number | null) { if (!disabled && canMutate() && command.canStart()) onChange(id); }
  function create() {
    if (!disabled && canMutate() && name.trim()) void command.run({ kind: "create", name });
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted">分类（可选）</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={categoryChipCls(value === null)} aria-pressed={value === null} disabled={busy} onClick={() => select(null)}>
          未分类
        </button>
        {(categories ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            className={categoryChipCls(value === c.id)}
            aria-pressed={value === c.id}
            disabled={busy}
            onClick={() => select(c.id)}
          >
            {c.name}
          </button>
        ))}
        {!creating && (
          <button
            type="button"
            className={`${categoryChipCls(false)} text-primary`}
            disabled={busy}
            onClick={() => { if (!disabled && canMutate() && command.canStart()) setCreating(true); }}
          >
            + 新建分类
          </button>
        )}
      </div>
      {value !== null && categories !== null && !categories.some(category => category.id === value) && <p className="mt-2 text-xs text-muted [overflow-wrap:anywhere]">当前选择：{createdCategory?.id === value ? createdCategory.name : `分类 #${value}`}（未出现在当前分类列表中，可重新读取或选择其他分类。）</p>}
      {categoriesError && <div role="alert" className={`mt-2 space-y-2 text-sm ${textErr}`}><p>分类加载失败：{categoriesError}</p><button type="button" className={btnGhost} disabled={busy} onClick={reload}>重试加载分类</button></div>}
      {categories === null && !categoriesError && <p role="status" className="mt-2 text-xs text-muted">正在读取分类…</p>}
      <div className="mt-2"><CategoryCommandFeedback command={command} /></div>
      {creating && (
        <div className="mt-2.5 flex gap-2">
          <input
            className={`${inputCls} flex-1`}
            aria-label="新分类名称"
            value={name}
            disabled={busy}
            onChange={(e) => { if (!disabled && canMutate() && command.canStart()) setName(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                create();
              }
            }}
            placeholder="新分类名称"
            maxLength={30}
            autoFocus
          />
          <button type="button" className={btnGhost} onClick={create} disabled={busy || !name.trim()}>
            创建
          </button>
        </div>
      )}
    </div>
  );
}

/** 星标收藏按钮：未收藏时选择分类，取消收藏前明确快照与复习历史的删除范围。 */
type NotebookStarProps = {
  source: "drill" | "interview";
  sourceId: number;
  question: string;
  notebookId: number | null;
  onChanged: (notebookId: number | null, review?: ReviewLink | null) => void;
};

export function NotebookStarButton(props: NotebookStarProps) {
  return <NotebookStarSession key={`${props.source}:${props.sourceId}:${props.notebookId ?? "none"}`} {...props} />;
}

function NotebookStarSession({
  source,
  sourceId,
  question,
  notebookId,
  onChanged,
}: NotebookStarProps) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const categoryIdRef = useRef<number | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const pickerPending = useRef(false);
  const favoriteCommand = useNotebookFavorite(saved => {
    onChanged(saved.id, saved.review);
    window.dispatchEvent(new Event("reviews-updated"));
    setOpen(false);
  });
  const busy = favoriteCommand.busy;
  const deletion = useNotebookDeletion(() => {
    onChanged(null, null);
    window.dispatchEvent(new Event("reviews-updated"));
  });
  const favorited = notebookId !== null && !deletion.deletedIds.has(notebookId);

  async function toggle() {
    if (!favoriteCommand.canStart() || pickerPending.current || !deletion.canStart()) return;
    if (!favorited) {
      setCategoryId(null);
      categoryIdRef.current = null;
      setOpen(true);
      return;
    }
    await deletion.remove({ id: notebookId!, question, source });
  }

  async function favorite() {
    if (pickerPending.current || !deletion.canStart()) return;
    await favoriteCommand.save({ source, sourceId, question, categoryId: categoryIdRef.current });
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || pickerBusy || deletion.busy}
        aria-busy={busy || pickerBusy || deletion.busy}
        aria-pressed={favorited}
        aria-label={favorited ? "取消收藏" : "收藏到错题本"}
        title={favorited ? "已在错题本中，点击取消收藏" : "收藏到错题本"}
        className={`ml-auto flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-50 ${
          favorited ? "font-medium text-accent" : "text-faint"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill={favorited ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z" />
        </svg>
        {favorited ? "已收藏" : "收藏"}
      </button>
      {!open && favoriteCommand.error && <p role="alert" className={`min-w-0 basis-full break-words text-xs ${textErr}`}>{favoriteCommand.error}</p>}
      {(deletion.busy || deletion.error || deletion.notice) && <div role="region" aria-label="错题移出状态" className="min-w-0 w-full basis-full space-y-2 text-left"><ToolHistoryDeletionFeedback deletion={deletion} deletingLabel="正在移出错题…" /></div>}
      {open && (
        <NotebookDialog
          title="收藏到错题本"
          onClose={() => { if (favoriteCommand.canStart() && !pickerPending.current) setOpen(false); }}
          dismissDisabled={busy || pickerBusy}
        >
          <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">{question}</p>
          <div className="mt-4">
            <CategoryPicker value={categoryId} onChange={id => { categoryIdRef.current = id; setCategoryId(id); }} disabled={busy} canMutate={() => favoriteCommand.canStart() && deletion.canStart()} onBusyChange={locked => { pickerPending.current = locked; setPickerBusy(locked); }} />
          </div>
          <div className="mt-3 space-y-2 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
            <p className="text-xs text-muted">来源：{source === "drill" ? "题目练习" : "模拟面试"} #{sourceId}</p>
            {favoriteCommand.error && <p role="alert" className={textErr}>{favoriteCommand.error}</p>}
            {favoriteCommand.notice && <p role="status" className="text-primary">{favoriteCommand.notice}</p>}
            {(favoriteCommand.phase === "posting" || favoriteCommand.phase === "checking") && <p role="status" className="text-muted">{favoriteCommand.phase === "posting" ? "正在收藏…" : "正在只读核对收藏状态…"}</p>}
            {busy && favoriteCommand.phase !== "posting" && <div className="flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} disabled={favoriteCommand.phase === "checking"} onClick={favoriteCommand.reread}>重新读取收藏状态</button>
              {favoriteCommand.phase === "missing" && <button type="button" className={btnGhost} onClick={favoriteCommand.allowRetry}>保留选择并允许重试</button>}
            </div>}
            {favoriteCommand.existing && <div className="space-y-2">
              <details className="max-h-64 overflow-y-auto rounded-xl border border-line p-3">
                <summary className="cursor-pointer font-medium">查看现有收藏快照 #{favoriteCommand.existing.id}</summary>
                {(["question", "answer", "comment", "reference"] as const).map((key, index) => <div key={key} className="mt-2"><p className="text-xs text-muted">{["题目", "原始回答", "点评", "参考答案"][index]}</p><p>{favoriteCommand.existing![key] || "（空）"}</p></div>)}
              </details>
              <button type="button" className={btnGhost} onClick={favoriteCommand.useExisting}>使用现有收藏</button>
            </div>}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => { if (favoriteCommand.canStart() && !pickerPending.current) setOpen(false); }} disabled={busy || pickerBusy}>
              取消
            </button>
            <button className={btnPrimary} onClick={favorite} disabled={busy || pickerBusy}>
              收藏
            </button>
          </div>
        </NotebookDialog>
      )}
    </>
  );
}

type CategoryChangeProps = {
  entryId: number;
  question: string;
  initialCategoryId: number | null;
  onClose: () => void;
  onSaved: () => void;
};
/** 移动命令按收藏 ID 隔离，旧对象的迟到结果不能关闭新对象弹窗。 */
export function CategoryChangeDialog(props: CategoryChangeProps) {
  return <CategoryChangeSession key={props.entryId} {...props} />;
}
function CategoryChangeSession({
  entryId,
  question,
  initialCategoryId,
  onClose,
  onSaved,
}: CategoryChangeProps) {
  const [categoryId, setCategoryId] = useState<number | null>(initialCategoryId);
  const categoryIdRef = useRef(initialCategoryId);
  const [pickerBusy, setPickerBusy] = useState(false); const pickerPending = useRef(false);
  const command = useNotebookCategoryCommand(() => { onSaved(); onClose(); });
  const busy = command.busy || pickerBusy;
  function close() { if (!pickerPending.current && command.canStart()) onClose(); }
  function save() {
    if (!pickerPending.current) void command.run({ kind: "move", id: entryId, categoryId: categoryIdRef.current, question });
  }

  return (
    <NotebookDialog title="移动到分类" onClose={close} dismissDisabled={busy}>
      <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">{question}</p>
      <div className="mt-4">
        <CategoryPicker value={categoryId} onChange={id => { categoryIdRef.current = id; setCategoryId(id); }} disabled={command.busy} canMutate={command.canStart} onBusyChange={locked => { pickerPending.current = locked; setPickerBusy(locked); }} />
      </div>
      <div className="mt-3"><CategoryCommandFeedback command={command} /></div>
      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={close} disabled={busy}>
          取消
        </button>
        <button className={btnPrimary} onClick={save} disabled={busy}>
          保存
        </button>
      </div>
    </NotebookDialog>
  );
}

/** 自定义分类管理：新建、重命名、删除（错题本列表页使用） */
export function CategoryManageDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const { categories: storedCategories, error: categoriesError, reload } = useNotebookCategories();
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [removedIds, setRemovedIds] = useState<ReadonlySet<number>>(() => new Set());
  const command = useNotebookCategoryCommand(input => {
    if (input.kind === "create") setName("");
    if (input.kind === "rename") setEditingId(null);
    if (input.kind === "delete") setRemovedIds(previous => new Set([...previous, input.id]));
    reload(); onChanged();
  });
  const busy = command.busy;
  const categories = storedCategories?.filter(category => !removedIds.has(category.id)) ?? null;
  function close() { if (command.canStart()) onClose(); }
  function create() { if (name.trim()) void command.run({ kind: "create", name }); }
  function rename(id: number) { if (editName.trim()) void command.run({ kind: "rename", id, name: editName }); }
  function remove(category: NotebookCategory) { void command.run({ kind: "delete", id: category.id, name: category.name, entryCount: category.entry_count }); }

  return (
    <NotebookDialog title="管理分类" onClose={close} dismissDisabled={busy}>
      <div className="mt-4 flex gap-2">
        <input
          className={`${inputCls} flex-1`}
          aria-label="新分类名称"
          value={name}
          disabled={busy}
          onChange={(e) => { if (command.canStart()) setName(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              create();
            }
          }}
          placeholder="新分类名称"
          maxLength={30}
        />
        <button className={btnPrimary} onClick={create} disabled={busy || !name.trim()}>
          新建
        </button>
      </div>
      <div className="mt-3"><CategoryCommandFeedback command={command} /></div>
      {categoriesError && <div role="alert" className={`mt-3 space-y-2 text-sm ${textErr}`}><p>分类加载失败：{categoriesError}</p><button type="button" className={btnGhost} onClick={reload} disabled={busy}>重试加载分类</button></div>}
      <ul className="mt-4 max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
        {categories === null ? !categoriesError && (
          <>
            <li className="skeleton mt-3 h-9 w-full" />
            <li className="skeleton mt-2 h-9 w-3/4" />
          </>
        ) : categories.length === 0 ? (
          <li className="py-4 text-sm text-faint">还没有分类，先新建一个。</li>
        ) : (
          categories.map((c) => (
            <li key={c.id} className="py-2.5">
              {editingId === c.id ? (
                <div className="flex gap-2">
                  <input
                    className={`${inputCls} flex-1`}
                    aria-label={`重命名分类：${c.name}`}
                    value={editName}
                    disabled={busy}
                    onChange={(e) => { if (command.canStart()) setEditName(e.target.value); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        rename(c.id);
                      }
                    }}
                    maxLength={30}
                    autoFocus
                  />
                  <button className={btnGhost} onClick={() => rename(c.id)} disabled={busy || !editName.trim()}>
                    保存
                  </button>
                  <button className={btnGhost} disabled={busy} onClick={() => { if (command.canStart()) setEditingId(null); }}>
                    取消
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{c.name}</p>
                    <p className="font-mono text-xs text-faint">{c.entry_count} 道题</p>
                  </div>
                  <div className="flex shrink-0 gap-3">
                    <button
                      className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                      disabled={busy}
                      onClick={() => {
                        if (!command.canStart()) return;
                        setEditingId(c.id);
                        setEditName(c.name);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="text-xs font-medium text-danger underline-offset-2 hover:underline"
                      disabled={busy && command.phase !== "confirming"}
                      onClick={() => remove(c)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))
        )}
      </ul>
      <div className="mt-4 flex justify-end">
        <button className={btnGhost} onClick={close} disabled={busy}>
          完成
        </button>
      </div>
    </NotebookDialog>
  );
}
