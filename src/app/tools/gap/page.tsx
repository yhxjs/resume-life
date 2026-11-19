"use client";

import { GapGeneratorForm } from "./gap-generator-form";
import { GapHistory } from "./gap-history";
import { GapPresetLibrary } from "./gap-preset-library";
import { useGapRemedies } from "./use-gap-remedies";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { btnPrimary, cardCls, textErr } from "@/lib/ui";

export default function CareerGapRemediesPage() {
  const view = useGapRemedies();

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">离职与空窗沟通准备</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">帮助你如实说明裁员、离职、休整、备考或创业经历，整理岗位相关信息与可能的追问，保留未知事项和个人隐私边界。</p>
        </div>
        {view.records !== null && <div className="flex items-center gap-2 text-xs text-muted"><span>已载入沟通记录：<strong className="font-mono text-ink font-bold text-sm">{view.records.length}</strong> 份{view.total !== null && ` / 共 ${view.total} 份`}</span></div>}
      </div>

      <GapPresetLibrary
        presetTab={view.presetTab}
        presets={view.filteredPresets}
        inspectPreset={view.inspectPreset}
        copiedText={view.copiedText}
        copyError={view.copyError}
        copying={view.copying}
        inputLocked={view.submitting}
        setPresetTab={view.setPresetTab}
        setInspectPreset={view.setInspectPreset}
        onUsePreset={view.usePreset}
        onCopy={view.copyScript}
      />
      <GapGeneratorForm
        scenarioType={view.scenarioType}
        rawStory={view.rawStory}
        targetRole={view.targetRole}
        personaStyle={view.personaStyle}
        submitting={view.submitting}
        creationBlocked={view.deletion.busy}
        setScenarioType={view.setScenarioType}
        setRawStory={view.setRawStory}
        setTargetRole={view.setTargetRole}
        setPersonaStyle={view.setPersonaStyle}
        onGenerate={view.handleGenerate}
      />

      {view.error && <p role="alert" aria-label="空窗方案生成状态" className={`text-sm ${textErr}`}>{view.error}</p>}
      <ToolHistoryDeletionFeedback deletion={view.deletion} />
      {view.loadError && <LoadError message={`沟通记录加载失败：${view.loadError}`} onRetry={view.failedCursor === null ? view.reload : view.loadMore} />}
      {view.records === null && !view.loadError && <Loading label="正在加载沟通记录…" />}
      {view.records !== null && view.records.length > 0 && <GapHistory records={view.records} onRemove={view.removeRecord} disabled={view.submitting || view.deletion.busy} />}
      {view.nextCursor && (
        <div className="flex justify-center">
          <button type="button" className={btnPrimary} onClick={view.loadMore} disabled={view.loadingMore}>
            {view.loadingMore ? "加载中…" : view.failedCursor === view.nextCursor ? "重试加载更多" : "加载更多"}
          </button>
        </div>
      )}
      {view.records !== null && view.records.length === 0 && <p className={`text-center text-xs text-faint py-6 ${cardCls}`}>暂无沟通记录：可在上方填写愿意披露的经历，或查看沟通示例</p>}
    </div>
  );
}
