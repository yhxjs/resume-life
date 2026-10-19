"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/common/modal";
import { btnGhost, btnPrimary, inputCls, textareaShortCls } from "@/lib/ui";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { getResumeSaveQueue } from "@/lib/resume-save-queue";
import type { ResumeVersion } from "@/lib/resume-version-types";

export function PublishVersionButton({ resumeId, onPublished }: { resumeId: string; onPublished?: (version: ResumeVersion) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await getResumeSaveQueue(resumeId).drain();
      const current = await jsonFetch<{ draft_revision: string }>(`/api/resumes/${resumeId}/versions`);
      const version = await jsonFetch<ResumeVersion>(`/api/resumes/${resumeId}/versions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim(), draft_revision: current.draft_revision }),
      });
      setOpen(false);
      setName("");
      setDescription("");
      if (onPublished) onPublished(version);
      else router.push(`/resumes/${resumeId}/versions?version=${version.id}`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  return <>
    <button type="button" className={btnPrimary} onClick={() => { setError(""); setOpen(true); }}>发布新版本</button>
    <Modal
      open={open}
      title="发布简历版本"
      onClose={() => { if (!busy) setOpen(false); }}
      escapeDisabled={busy}
      closeOnBackdrop={!busy}
      loading={busy}
      loadingText="正在冻结保存并发布新版本…"
      loadingDescription="正在保存未结草稿并生成不可篡改的版本快照，请稍候…"
    >
      <form onSubmit={publish} className="space-y-5">
        <div><h2 className="font-serif text-xl font-bold">发布简历版本</h2><p className="mt-2 text-sm leading-relaxed text-muted">将当前草稿保存为固定版本。发布后可用于投递、面试和自我介绍，继续编辑草稿不会改变此版本。</p></div>
        <label className="block space-y-2 text-sm"><span>版本名称 <span className="text-muted">（必填）</span></span><input autoFocus required maxLength={80} className={inputCls} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：前端岗位 · 强化项目成果" disabled={busy} /></label>
        <label className="block space-y-2 text-sm"><span>修改说明 <span className="text-muted">（选填）</span></span><textarea maxLength={2000} className={textareaShortCls} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="记录这次调整的原因与重点；具体内容变化会自动比较。" disabled={busy} /></label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={btnGhost} disabled={busy} onClick={() => setOpen(false)}>取消</button><button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>{busy ? "正在保存并发布…" : "确认发布"}</button></div>
      </form>
    </Modal>
  </>;
}
