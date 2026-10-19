"use client";

/** 错题本共享件：收藏星标按钮（练习/面试详情页共用）与分类弹窗（选择 / 管理） */

import { useEffect, useState } from "react";
import { alertDialog, confirmDialog } from "@/components/common/confirm-dialog";
import { CompactModal } from "@/components/common/modal-variants";
import { jsonFetch } from "@/lib/fetcher";
import { btnGhost, btnPrimary, inputCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

export type NotebookCategory = { id: number; name: string; entry_count: number };

function errText(err: unknown): string {
  return errorMessage(err);
}

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
  return `rounded-full border px-3 py-1 text-xs transition-colors ${
    active
      ? "border-primary/40 bg-primary-soft font-medium text-primary"
      : "border-line text-muted hover:bg-surface"
  }`;
}

/** 分类单选 + 行内新建分类；value 为 null 表示未分类 */
function CategoryPicker({
  value,
  onChange,
  onError,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  onError: (message: string) => void;
}) {
  const [categories, setCategories] = useState<NotebookCategory[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    jsonFetch<NotebookCategory[]>("/api/notebook/categories")
      .then((categories) => {
        if (cancelled) return;
        setCategories(categories);
      })
      .catch((err) => {
        if (cancelled) return;
        onError(errText(err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await jsonFetch<{ id: number; name: string }>("/api/notebook/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setCategories((list) => [...(list ?? []), { ...created, entry_count: 0 }]);
      onChange(created.id);
      setName("");
      setCreating(false);
    } catch (err) {
      onError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted">分类（可选）</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={categoryChipCls(value === null)} onClick={() => onChange(null)}>
          未分类
        </button>
        {(categories ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            className={categoryChipCls(value === c.id)}
            onClick={() => onChange(c.id)}
          >
            {c.name}
          </button>
        ))}
        {!creating && (
          <button
            type="button"
            className={`${categoryChipCls(false)} text-primary`}
            onClick={() => setCreating(true)}
          >
            + 新建分类
          </button>
        )}
      </div>
      {creating && (
        <div className="mt-2.5 flex gap-2">
          <input
            className={`${inputCls} flex-1`}
            aria-label="新分类名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="新分类名称"
            maxLength={30}
            autoFocus
          />
          <button className={btnGhost} onClick={create} disabled={busy || !name.trim()}>
            创建
          </button>
        </div>
      )}
    </div>
  );
}

/** 星标收藏按钮：未收藏时点击弹出分类选择；已收藏时点击直接取消收藏 */
export function NotebookStarButton({
  source,
  sourceId,
  question,
  notebookId,
  onChanged,
}: {
  source: "drill" | "interview";
  sourceId: number;
  question: string;
  notebookId: number | null;
  onChanged: (notebookId: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const favorited = notebookId !== null;

  async function toggle() {
    if (!favorited) {
      setCategoryId(null);
      setError("");
      setOpen(true);
      return;
    }
    try {
      await jsonFetch(`/api/notebook/${notebookId}`, { method: "DELETE" });
      onChanged(null);
    } catch (err) {
      alertDialog({ title: "取消收藏失败", message: errText(err) });
    }
  }

  async function favorite() {
    setBusy(true);
    setError("");
    try {
      const entry = await jsonFetch<{ id: number }>("/api/notebook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, source_id: sourceId, category_id: categoryId }),
      });
      onChanged(entry.id);
      setOpen(false);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={favorited}
        aria-label={favorited ? "取消收藏" : "收藏到错题本"}
        title={favorited ? "已在错题本中，点击取消收藏" : "收藏到错题本"}
        className={`flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
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
      {open && (
        <NotebookDialog
          title="收藏到错题本"
          onClose={() => setOpen(false)}
          dismissDisabled={busy}
        >
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted">{question}</p>
          <div className="mt-4">
            <CategoryPicker value={categoryId} onChange={setCategoryId} onError={setError} />
          </div>
          {error && <p className={`mt-3 text-sm ${textErr}`}>{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setOpen(false)} disabled={busy}>
              取消
            </button>
            <button className={btnPrimary} onClick={favorite} disabled={busy}>
              收藏
            </button>
          </div>
        </NotebookDialog>
      )}
    </>
  );
}

/** 移动某道错题到其他分类（错题本列表页使用） */
export function CategoryChangeDialog({
  entryId,
  question,
  initialCategoryId,
  onClose,
  onSaved,
}: {
  entryId: number;
  question: string;
  initialCategoryId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState<number | null>(initialCategoryId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await jsonFetch(`/api/notebook/${entryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category_id: categoryId }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <NotebookDialog title="移动到分类" onClose={onClose} dismissDisabled={busy}>
      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted">{question}</p>
      <div className="mt-4">
        <CategoryPicker value={categoryId} onChange={setCategoryId} onError={setError} />
      </div>
      {error && <p className={`mt-3 text-sm ${textErr}`}>{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose} disabled={busy}>
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
  const [categories, setCategories] = useState<NotebookCategory[] | null>(null);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function load(isCancelled?: () => boolean) {
    jsonFetch<NotebookCategory[]>("/api/notebook/categories")
      .then((list) => {
        if (isCancelled?.()) return;
        setCategories(list);
      })
      .catch((err) => {
        if (isCancelled?.()) return;
        setError(errText(err));
      });
  }

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, []);

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await jsonFetch("/api/notebook/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setName("");
      load();
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: number) {
    if (!editName.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await jsonFetch(`/api/notebook/categories/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName }),
      });
      setEditingId(null);
      load();
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: NotebookCategory) {
    const ok = await confirmDialog({
      title: "删除分类",
      message: `删除分类「${c.name}」？其中的错题将变为未分类。`,
      danger: true,
    });
    if (!ok) return;
    setError("");
    try {
      await jsonFetch(`/api/notebook/categories/${c.id}`, { method: "DELETE" });
      load();
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <NotebookDialog title="管理分类" onClose={onClose} dismissDisabled={busy}>
      <div className="mt-4 flex gap-2">
        <input
          className={`${inputCls} flex-1`}
          aria-label="新分类名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
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
      {error && <p className={`mt-3 text-sm ${textErr}`}>{error}</p>}
      <ul className="mt-4 max-h-72 divide-y divide-line overflow-y-auto border-t border-line">
        {categories === null ? (
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
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
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
                  <button className={btnGhost} onClick={() => setEditingId(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{c.name}</p>
                    <p className="font-mono text-xs text-faint">{c.entry_count} 道题</p>
                  </div>
                  <div className="flex shrink-0 gap-3">
                    <button
                      className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditName(c.name);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="text-xs font-medium text-danger underline-offset-2 hover:underline"
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
        <button className={btnGhost} onClick={onClose}>
          完成
        </button>
      </div>
    </NotebookDialog>
  );
}
