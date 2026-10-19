"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams } from "next/navigation";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { btnPrimary, btnGhost } from "@/lib/ui";
import { ProjectMaterialsPanel } from "./project-materials-panel";
import { ProjectSummaryWorkbench } from "./project-summary-workbench";
import { ScanRepoModal } from "./scan-repo-modal";
import { useProjectDetail } from "./use-project-detail";
import { useProjectRepoPaths } from "./use-project-repo-paths";
import { ProjectSummaryHistory } from "./project-summary-history";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import { normalizeSummary } from "@/lib/summary";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const view = useProjectDetail(params.id);
  const repoPathsManager = useProjectRepoPaths(params.id);
  const [scanModalOpen, setScanModalOpen] = useState(false);

  if (view.error && !view.data) return <LoadError message={view.error} onRetry={view.retryLoad} />;
  if (!view.data) return <Loading />;

  const { data, material, summary } = view;
  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Link href="/knowledge" className="text-xs font-medium text-muted transition-colors hover:text-primary">← 返回项目知识库</Link>
            <span className="text-xs text-faint">/</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary-soft px-2.5 py-0.5 text-[11px] font-medium text-primary"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" /><span>STAR 亮点提炼工作台</span></span>
          </div>
          <h1 className="font-serif text-[26px] sm:text-[32px] font-bold text-ink leading-tight">{data.name}</h1>
          <p className="mt-1 text-xs text-muted">已收录材料 <strong className="font-mono text-ink font-bold">{data.materials_total ?? data.materials.length}</strong> 份{data.summary_updated_at && <span> · STAR 亮点总结更新于 {new Date(data.summary_updated_at).toLocaleString()}</span>}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            className={btnGhost}
            onClick={() => setScanModalOpen(true)}
          >
            📂 扫描本地代码仓库
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => summary.summarize("full")}
            disabled={summary.summarizing}
          >
            {summary.summarizing ? "AI 提炼总结中…" : data.summary_updated_at ? "✨ 重新生成 STAR 总结" : "✨ 生成 AI STAR 总结"}
          </button>
        </div>
      </div>

      {data.summary_corrupt && <div className="rounded-2xl border border-accent/40 bg-accent-wash/60 p-4 text-xs text-accent">⚠️ 已保存的总结数据异常或格式损坏；直接保存将覆盖原内容，强烈建议点击上方「重新生成 STAR 总结」。</div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <ProjectSummaryWorkbench
          summaryDraft={summary.summaryDraft}
          pendingDraft={summary.pendingDraft}
          proposal={summary.proposal}
          selectedKeys={summary.selectedKeys}
          canConfirmDraft={summary.canConfirmDraft}
          summarizing={summary.summarizing}
          savingSummary={summary.savingSummary}
          sumStatus={summary.sumStatus}
          typewriter={summary.typewriter}
          materialCount={data.materials_total ?? data.materials.length}
          onSummarize={summary.summarize}
          onDiscardDraft={summary.discardDraft}
          onSaveSummary={summary.saveSummary}
          onChange={summary.updateSummaryField}
          onUpdateAchievement={summary.updateAchievementItem}
          onAddAchievement={summary.addAchievementItem}
          onRemoveAchievement={summary.removeAchievementItem}
          onToggleAdoption={summary.toggleAdoption}
        />
        <ProjectMaterialsPanel
          materials={data.materials}
          materialsTotal={data.materials_total}
          error={view.error}
          projectId={data.id}
          repoPaths={repoPathsManager.repoPaths}
          onAddRepoPath={repoPathsManager.addPath}
          onRemoveRepoPath={repoPathsManager.removePath}
          onClearRepoPaths={repoPathsManager.clearPaths}
          onOpenScanModal={() => setScanModalOpen(true)}
          {...material}
        />
      </div>

      <ProjectSummaryHistory projectId={data.id} revisionId={data.summary_revision_id ?? 0} />

      <ScanRepoModal
        open={scanModalOpen}
        projectId={data.id}
        projectName={data.name}
        repoPaths={repoPathsManager.repoPaths}
        onPathsChange={repoPathsManager.setRepoPaths}
        onClose={() => setScanModalOpen(false)}
        onSuccess={(scanned, repoPath) => {
          const generated = normalizeSummary(scanned.summary);
          summary.applyDraft(
            {
              summary: generated,
              comparison: scanned.comparison ?? compareProjectSummaries(data.summary, generated, {}),
              materialChanges: scanned.materialChanges ?? [],
              materialFingerprint: scanned.materialFingerprint ?? "",
              revisionId: scanned.revisionId ?? data.summary_revision_id ?? 0,
              source: "repo",
            },
            `已通过扫描仓库「${repoPath}」提炼出五维 STAR 项目亮点！请在下方核验，确认后才会写入项目档案`
          );
        }}
      />
    </div>
  );
}
