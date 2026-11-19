"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/common/modal";
import { Loading } from "@/components/common/ui-bits";
import { useCursorList } from "@/hooks/use-cursor-list";
import { PREPARATION_LABELS, type PreparationKind, type PreparationResource } from "@/lib/application-preparation-types";
import { btnGhost, btnPrimary } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { readPreparationResourcePage } from "@/lib/application-preparation-response";

type PreparationResourcePickerProps = {
  applicationId: number; kind: PreparationKind; onClose: () => void;
  onSelect: (id: number) => Promise<boolean>;
  writesBlocked?: boolean;
};

export function PreparationResourcePicker(props: PreparationResourcePickerProps) {
  return <PreparationResourcePickerContent key={JSON.stringify([props.applicationId, props.kind])} {...props} />;
}

function PreparationResourcePickerContent({ applicationId, kind, onClose, onSelect, writesBlocked = false }: PreparationResourcePickerProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<{ id: number; message: string } | null>(null);
  const selection = useRef<AbortController | null>(null);
  const active = useRef(true);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const saving = selectedId !== null;
  const list = useCursorList<PreparationResource>({
    queryKey: `preparation-candidates:${applicationId}:${kind}`,
    buildUrl: (cursor) => `/api/applications/${applicationId}/preparation/resources?kind=${kind}&candidates=true&limit=20${cursor ? `&cursor=${cursor}` : ""}`,
    delay: 0,
    validatePage: (page, cursor) => {
      const candidates = readPreparationResourcePage(page, kind, cursor);
      if (candidates.items.some(item => item.linked)) throw new Error("候选资料包含已关联记录，请重新加载");
    },
  });

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; selection.current?.abort(); selection.current = null; };
  }, []);
  useEffect(() => { if (error || list.listError || writesBlocked) errorRef.current?.focus(); }, [error, list.listError, writesBlocked]);

  function close() {
    if (active.current && !selection.current) onClose();
  }

  async function select(id: number) {
    if (!active.current || selection.current || writesBlocked) return;
    const controller = new AbortController();
    selection.current = controller;
    setSelectedId(id); setError(null);
    const isCurrent = () => selection.current === controller && !controller.signal.aborted;
    try {
      const linked = await onSelect(id);
      if (!isCurrent()) return;
      if (linked) onClose();
      else setError({ id, message: "关联失败，请重试或选择其他资料；详细原因见准备页提示。" });
    } catch (reason) {
      if (isCurrent()) setError({ id, message: errorMessage(reason) });
    } finally {
      if (selection.current === controller) { selection.current = null; setSelectedId(null); }
    }
  }

  function retryList() {
    if (!active.current || selection.current) return;
    if (typeof list.failedCursor === "string") list.loadMore();
    else list.reload();
  }

  return <Modal open onClose={close} closeOnBackdrop={!saving} escapeDisabled={saving} title={`关联已有${PREPARATION_LABELS[kind]}`}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-serif text-lg font-bold">关联已有{PREPARATION_LABELS[kind]}</h2>
      <button type="button" className={btnGhost} onClick={close} disabled={saving}>关闭</button>
    </div>
    <p className="mt-2 text-sm text-muted">选择用于这次投递的资料，同一份资料可以用于多条投递。</p>
    {saving && <p role="status" className="mt-3 text-sm text-primary">正在关联资料，请稍候…</p>}
    {(error || list.listError || writesBlocked) && <div ref={errorRef} role="alert" tabIndex={-1} className="mt-3 space-y-2 text-sm text-danger outline-none focus-visible:ring-2 focus-visible:ring-danger/40">
      {writesBlocked ? <p>关联结果尚未确认，请关闭此窗口并刷新资料核对。</p> : error && <p>{error.message} <button type="button" className={btnGhost} disabled={saving} onClick={() => void select(error.id)}>重试关联</button></p>}
      {list.listError && <p>{list.listError} <button type="button" className={btnGhost} disabled={saving || list.loading || list.loadingMore} onClick={retryList}>{typeof list.failedCursor === "string" ? "重试加载更多" : "重试加载列表"}</button></p>}
    </div>}
    {list.items === null && !list.listError ? <Loading /> : <ul className="mt-4 max-h-[55dvh] divide-y divide-line overflow-y-auto">
      {list.items?.map((item) => <li key={item.id} className="flex items-start justify-between gap-4 py-4">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold">{item.title}</h3>
          <p className="mt-1 line-clamp-2 break-words text-xs text-muted">{item.summary}</p>
          <p className="mt-2 text-xs text-muted">#{item.id} · {item.created_at ? new Date(item.created_at).toLocaleDateString() : "历史记录"}</p>
        </div>
        <button type="button" className={`${btnPrimary} shrink-0`} disabled={saving || writesBlocked} onClick={() => void select(item.id)}>{selectedId === item.id ? "关联中…" : "关联"}</button>
      </li>)}
      {list.items?.length === 0 && <li className="py-8 text-center text-sm text-muted">暂无可关联的记录，可以返回准备页生成。</li>}
    </ul>}
    {list.hasMore && <button type="button" className={`${btnGhost} mt-3`} disabled={list.loadingMore || saving} onClick={() => { if (!selection.current) list.loadMore(); }}>{list.loadingMore ? "加载中…" : "加载更多"}</button>}
  </Modal>;
}
