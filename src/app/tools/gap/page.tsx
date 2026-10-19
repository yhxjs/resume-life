"use client";

import { GapGeneratorForm } from "./gap-generator-form";
import { GapHistory } from "./gap-history";
import { GapPresetLibrary } from "./gap-preset-library";
import { useGapRemedies } from "./use-gap-remedies";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { btnPrimary, cardCls, textErr } from "@/lib/ui";

export default function CareerGapRemediesPage() {
  const view = useGapRemedies();

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">离职原因与空窗期高情商对策库</h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">将裁员、内耗、裸辞、Gap、考公考研或创业试错等敏感经历，重塑为合理求职动机与成长契机，生成 HR 听着舒适、合规加分的说服力话术。</p>
        </div>
        {view.records !== null && <div className="flex items-center gap-2 text-xs text-muted"><span>已载入对策存档：<strong className="font-mono text-ink font-bold text-sm">{view.records.length}</strong> 份{view.total !== null && ` / 共 ${view.total} 份`}</span></div>}
      </div>

      <GapPresetLibrary
        presetTab={view.presetTab}
        presets={view.filteredPresets}
        inspectPreset={view.inspectPreset}
        copiedText={view.copiedText}
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
        setScenarioType={view.setScenarioType}
        setRawStory={view.setRawStory}
        setTargetRole={view.setTargetRole}
        setPersonaStyle={view.setPersonaStyle}
        onGenerate={view.handleGenerate}
      />

      {view.error && <p className={`text-sm ${textErr}`}>{view.error}</p>}
      {view.loadError && <LoadError message={`对策历史加载失败：${view.loadError}`} onRetry={view.failedCursor === null ? view.reload : view.loadMore} />}
      {view.records === null && !view.loadError && <Loading label="正在加载对策历史…" />}
      {view.records !== null && view.records.length > 0 && <GapHistory records={view.records} onRemove={view.removeRecord} />}
      {view.nextCursor && (
        <div className="flex justify-center">
          <button type="button" className={btnPrimary} onClick={view.loadMore} disabled={view.loadingMore}>
            {view.loadingMore ? "加载中…" : view.failedCursor === view.nextCursor ? "重试加载更多" : "加载更多"}
          </button>
        </div>
      )}
      {view.records !== null && view.records.length === 0 && <p className={`text-center text-xs text-faint py-6 ${cardCls}`}>暂无历史重塑对策：在上方输入您的敏感经历，或从经典对策库中选取体验吧</p>}
    </div>
  );
}
