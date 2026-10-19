"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { ResumeDoc } from "@/components/resume/doc";
import { prepare } from "@/components/resume/doc-data";
import { PublishVersionButton } from "@/components/resume/publish-version-button";
import { ResumeVersionDiff } from "@/components/resume/resume-version-diff";
import type { ResumeSnapshot, ResumeVersion, ResumeVersionListItem } from "@/lib/resume-version-types";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { getResumeSaveQueue } from "@/lib/resume-save-queue";
import { btnGhost, btnPrimary, inputCls } from "@/lib/ui";

type VersionsResponse = { versions: ResumeVersionListItem[]; base_version_id: number | null; draft_revision: string };
const versionLabel = (version: ResumeVersionListItem) => `v${version.version} · ${version.name}`;

function treeOrder(versions: ResumeVersionListItem[]): { version: ResumeVersionListItem; depth: number }[] {
  const children = new Map<number | null, ResumeVersionListItem[]>();
  const ids = new Set(versions.map((version) => version.id));
  for (const version of [...versions].sort((a, b) => a.version - b.version)) {
    const parent = version.parent_id !== null && ids.has(version.parent_id) ? version.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), version]);
  }
  const ordered: { version: ResumeVersionListItem; depth: number }[] = [];
  const stack = (children.get(null) ?? []).map((version) => ({ version, depth: 0 })).reverse();
  while (stack.length) {
    const node = stack.pop()!;
    ordered.push(node);
    const next = children.get(node.version.id) ?? [];
    stack.push(...next.map((version) => ({ version, depth: node.depth + 1 })).reverse());
  }
  return ordered;
}

export function ResumeVersionsPage({ resumeId }: { resumeId: string }) {
  const router = useRouter();
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [compareId, setCompareId] = useState<number | null>(null);
  const [view, setView] = useState<"diff" | "preview">("diff");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [branching, setBranching] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<number, ResumeSnapshot>>({});
  const snapshotsRef = useRef(snapshots);
  const [snapshotErrors, setSnapshotErrors] = useState<Record<number, string>>({});
  const [snapshotAttempt, setSnapshotAttempt] = useState(0);
  const comparisonRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === comparisonRef.current);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.fullscreenElement === comparisonRef.current) void document.exitFullscreen();
    };
    document.addEventListener("fullscreenchange", update);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      await getResumeSaveQueue(resumeId).drain();
      const result = await jsonFetch<VersionsResponse>(`/api/resumes/${resumeId}/versions`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const query = new URLSearchParams(window.location.search);
      const requested = Number(query.get("version") ?? query.get("versionId"));
      const current = result.versions.find((version) => version.id === requested) ?? result.versions[0];
      setData(result);
      setSelectedId(current?.id ?? null);
      setCompareId(current?.parent_id ?? null);
      setView(current?.parent_id ? "diff" : "preview");
      setError("");
    }
    void load().catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [resumeId, retry]);

  const selected = data?.versions.find((version) => version.id === selectedId);
  const compared = data?.versions.find((version) => version.id === compareId);
  const base = data?.versions.find((version) => version.id === data.base_version_id);
  const selectedSnapshot = selected ? snapshots[selected.id] : undefined;
  const comparedSnapshot = compared ? snapshots[compared.id] : undefined;
  const snapshotError = (selected && snapshotErrors[selected.id]) ||
    (view === "diff" && compared && snapshotErrors[compared.id]) || "";

  // 快照单份可达 2 MiB，仅加载查看/对比涉及的版本并在本页会话内缓存。
  useEffect(() => {
    if (!data) return;
    const needed = [...new Set([selectedId, compareId])].filter(
      (id): id is number => id !== null && snapshotsRef.current[id] === undefined
    );
    if (needed.length === 0) return;
    const controller = new AbortController();
    for (const id of needed) {
      void jsonFetch<ResumeVersion>(`/api/resumes/${resumeId}/versions/${id}`, { signal: controller.signal })
        .then((version) => {
          if (controller.signal.aborted) return;
          snapshotsRef.current = { ...snapshotsRef.current, [id]: version.snapshot };
          setSnapshots(snapshotsRef.current);
          setSnapshotErrors((previous) => {
            const errors = { ...previous };
            delete errors[id];
            return errors;
          });
        }).catch((reason) => {
          if (!controller.signal.aborted) setSnapshotErrors((previous) => ({ ...previous, [id]: errorMessage(reason) }));
        });
    }
    return () => controller.abort();
  }, [data, resumeId, selectedId, compareId, snapshotAttempt]);

  function select(version: ResumeVersionListItem) {
    setError("");
    setSelectedId(version.id);
    setCompareId(version.parent_id);
    setView(version.parent_id ? "diff" : "preview");
    window.history.replaceState(null, "", `/resumes/${resumeId}/versions?version=${version.id}`);
  }

  async function branch() {
    if (!selected || !data || branching) return;
    const accepted = await confirmDialog({ title: `从 v${selected.version} 开始分支`,
      message: "此版本的内容将替换当前草稿。尚未发布的草稿修改会被覆盖，请先发布需要保留的内容；已有发布版本和其他模块的版本绑定不会改变。",
      confirmText: "替换草稿并开始编辑", danger: true });
    if (!accepted) return;
    setBranching(true);
    setError("");
    try {
      await getResumeSaveQueue(resumeId).drain();
      await jsonFetch(`/api/resumes/${resumeId}/versions/${selected.id}/branch`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft_revision: data.draft_revision }),
      });
      router.push(`/resumes/${resumeId}`);
    } catch (reason) { setError(errorMessage(reason)); setBranching(false); }
  }

  function published(version: ResumeVersion) {
    // 发布同时改变草稿来源，重新读取服务端的草稿校验值。
    window.history.replaceState(null, "", `/resumes/${resumeId}/versions?version=${version.id}`);
    setRetry((value) => value + 1);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === comparisonRef.current) await document.exitFullscreen();
      else await comparisonRef.current?.requestFullscreen();
    } catch { setError("无法进入全屏展示，请检查浏览器的全屏权限。"); }
  }

  return <div className="mx-auto max-w-[1600px] space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
      <div className="min-w-0"><Link className="text-sm text-primary underline underline-offset-4" href={`/resumes/${resumeId}`}>← 返回简历草稿</Link><h1 className="mt-3 font-serif text-2xl font-bold">简历版本树</h1><p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">记录每一次发布，查看修改，也可以从任意历史版本继续打磨。</p></div>
      <PublishVersionButton resumeId={resumeId} onPublished={published} />
    </header>
    {(error || snapshotError) && <LoadError message={error || snapshotError} onRetry={() => {
      if (error) { setError(""); setRetry((value) => value + 1); }
      else { setSnapshotErrors({}); setSnapshotAttempt((value) => value + 1); }
    }} />}
    {!data ? !error && <Loading label="正在加载版本记录…" /> : !selected ? <div className="rounded-lg border border-dashed border-line-strong px-6 py-12 text-center"><h2 className="font-serif text-lg font-semibold">从第一次发布开始</h2><p className="mx-auto mt-3 max-w-prose text-sm leading-relaxed text-muted">当前简历还没有已发布版本。完成草稿后，点击“发布新版本”；每次发布都会保留内容和排版，供其他模块选择。</p></div> :
      <div className="grid min-w-0 gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="min-w-0" aria-label="版本树">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">发布记录</h2><span className="font-mono text-xs text-muted">{data.versions.length} 个版本</span></div>
          <p className="mb-4 rounded-lg bg-surface p-3 text-xs leading-relaxed text-muted">草稿来源：{base ? versionLabel(base) : "初始草稿"}</p>
          <ol className="space-y-1 overflow-x-auto pb-2">
            {treeOrder(data.versions).map(({ version, depth }) => <li key={version.id} style={{ paddingLeft: `${Math.min(depth, 6) * 12}px` }}>
              <button className={`w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary ${version.id === selectedId ? "border-primary/40 bg-primary-soft text-ink" : "border-transparent hover:bg-surface"}`} aria-current={version.id === selectedId ? "true" : undefined} onClick={() => select(version)}>
                <span className="flex gap-2 text-sm"><span className="font-mono text-primary">{depth > 0 ? "↳ " : "● "}v{version.version}</span><span className="min-w-0 flex-1 break-words font-medium">{version.name}</span></span>
                <span className="mt-1 block text-xs text-muted">{version.parent_id ? `来自 v${data.versions.find((item) => item.id === version.parent_id)?.version ?? "?"} · ` : "初始版本 · "}{new Date(version.created_at).toLocaleDateString("zh-CN")}</span>
              </button>
            </li>)}
          </ol>
        </aside>
        <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words font-serif text-xl font-bold">{versionLabel(selected)}</h2><p className="mt-1 text-xs text-muted">{new Date(selected.created_at).toLocaleString("zh-CN")} 发布 · 已固定</p></div><button type="button" className={btnGhost} disabled={branching} onClick={() => void branch()}>{branching ? "正在准备草稿…" : "从此版本开始分支"}</button></div>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{selected.description || "此版本未填写修改说明，可在下方查看具体变化。"}</p>
          <div ref={comparisonRef} className={`version-compare-viewport min-w-0 space-y-4 ${fullscreen ? "h-screen w-screen overflow-auto bg-bg p-4 sm:p-6" : ""}`}>
            <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-3">
              <div className="flex flex-wrap gap-2" aria-label="版本查看方式"><button className={view === "diff" ? btnPrimary : btnGhost} aria-pressed={view === "diff"} onClick={() => setView("diff")}>左右对照</button><button className={view === "preview" ? btnPrimary : btnGhost} aria-pressed={view === "preview"} onClick={() => setView("preview")}>查看此版本</button></div>
              <div className="flex flex-wrap items-end gap-3">
                {view === "diff" && <label className="max-w-full space-y-1 text-xs text-muted"><span className="block">左侧参照版本</span><select className={`${inputCls} max-w-80`} value={compareId ?? ""} onChange={(event) => setCompareId(event.target.value ? Number(event.target.value) : null)}><option value="">空白（查看完整新增）</option>{data.versions.filter((version) => version.id !== selected.id).map((version) => <option key={version.id} value={version.id}>{versionLabel(version)}{version.id === selected.parent_id ? " · 父版本" : ""}</option>)}</select></label>}
                <button type="button" className={btnGhost} onClick={() => void toggleFullscreen()}>{fullscreen ? "退出全屏" : "全屏展示"}</button>
              </div>
            </div>
            {view === "diff" ? (
              selectedSnapshot && (!compared || comparedSnapshot !== undefined) ?
                <ResumeVersionDiff before={compared ? comparedSnapshot! : null} after={selectedSnapshot} beforeLabel={compared ? versionLabel(compared) : "空白"} afterLabel={versionLabel(selected)} /> :
                !snapshotError && <Loading label="正在加载版本快照…" />) :
              selectedSnapshot ?
                <div className="overflow-x-auto rounded-lg border border-line bg-surface p-3" tabIndex={0} role="region" aria-label="已发布简历预览"><div className="paper mx-auto w-[210mm] min-h-[297mm] bg-white"><ResumeDoc prepared={prepare(selectedSnapshot.title, selectedSnapshot.modules)} style={selectedSnapshot.resolved_style} /></div></div> :
                !snapshotError && <Loading label="正在加载版本快照…" />}
          </div>
        </div>
      </div>}
  </div>;
}
