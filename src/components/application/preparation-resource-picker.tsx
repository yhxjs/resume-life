"use client";

import { useState } from "react";
import { Modal } from "@/components/common/modal";
import { Loading } from "@/components/common/ui-bits";
import { useCursorList } from "@/hooks/use-cursor-list";
import { PREPARATION_LABELS, type PreparationKind, type PreparationResource } from "@/lib/application-preparation-types";
import { btnGhost, btnPrimary } from "@/lib/ui";

export function PreparationResourcePicker({ applicationId, kind, onClose, onSelect }: {
  applicationId: number; kind: PreparationKind; onClose: () => void;
  onSelect: (id: number) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const list = useCursorList<PreparationResource>({
    queryKey: `preparation-candidates:${applicationId}:${kind}`,
    buildUrl: (cursor) => `/api/applications/${applicationId}/preparation/resources?kind=${kind}&candidates=true&limit=20${cursor ? `&cursor=${cursor}` : ""}`,
    delay: 0,
  });
  async function select(id: number) {
    if (saving) return;
    setSaving(true);
    if (await onSelect(id)) onClose();
    else { setError("关联失败，请重试；详细原因见准备页提示。"); setSaving(false); }
  }
  return <Modal open onClose={() => { if (!saving) onClose(); }} title={`关联已有${PREPARATION_LABELS[kind]}`}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-serif text-lg font-bold">关联已有{PREPARATION_LABELS[kind]}</h2>
      <button type="button" className={btnGhost} onClick={onClose} disabled={saving}>关闭</button>
    </div>
    <p className="mt-2 text-sm text-muted">选择用于这次投递的资料，同一份资料可以用于多条投递。</p>
    {(error || list.listError) && <p role="alert" className="mt-3 text-sm text-danger">{error || list.listError} <button className={btnGhost} onClick={list.reload}>重试</button></p>}
    {list.items === null && !list.listError ? <Loading /> : <ul className="mt-4 max-h-[55dvh] divide-y divide-line overflow-y-auto">
      {list.items?.map((item) => <li key={item.id} className="flex items-start justify-between gap-4 py-4">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold">{item.title}</h3>
          <p className="mt-1 line-clamp-2 break-words text-xs text-muted">{item.summary}</p>
          <p className="mt-2 text-xs text-muted">#{item.id} · {item.created_at ? new Date(item.created_at).toLocaleDateString() : "历史记录"}</p>
        </div>
        <button type="button" className={`${btnPrimary} shrink-0`} disabled={saving} onClick={() => void select(item.id)}>关联</button>
      </li>)}
      {list.items?.length === 0 && <li className="py-8 text-center text-sm text-muted">暂无可关联的记录，可以返回准备页生成。</li>}
    </ul>}
    {list.hasMore && <button type="button" className={`${btnGhost} mt-3`} disabled={list.loadingMore || saving} onClick={list.loadMore}>{list.loadingMore ? "加载中…" : "加载更多"}</button>}
  </Modal>;
}
