"use client";

import type { PresetRemedy } from "@/lib/career-gap-remedy";
import { badgePrimary, cardCls, wellCls } from "@/lib/ui";
import type { PresetTab } from "./gap-helpers";

type GapPresetLibraryProps = {
  presetTab: PresetTab;
  presets: PresetRemedy[];
  inspectPreset: PresetRemedy | null;
  copiedText: string;
  setPresetTab: (tab: PresetTab) => void;
  setInspectPreset: (preset: PresetRemedy | null) => void;
  onUsePreset: (preset: PresetRemedy) => void;
  onCopy: (text: string) => void;
};

export function GapPresetLibrary({ presetTab, presets, inspectPreset, copiedText, setPresetTab, setInspectPreset, onUsePreset, onCopy }: GapPresetLibraryProps) {
  return (
    <div className={`p-5 space-y-4 ${cardCls}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3">
        <div><h2 className="text-sm font-bold text-ink flex items-center gap-2"><span>📚 经典高频敏感场景百宝箱</span><span className="text-xs font-normal text-muted">（点击标签直接查看 HR 顾虑、高情商话术与禁忌）</span></h2></div>
        <div className="flex items-center gap-1 bg-surface-2 p-1 rounded-lg border border-line text-xs">
          <button type="button" onClick={() => setPresetTab("all")} className={`px-2.5 py-1 rounded-md transition-colors ${presetTab === "all" ? "bg-card text-ink font-semibold shadow-xs" : "text-muted hover:text-ink"}`}>全部场景</button>
          <button type="button" onClick={() => setPresetTab("resignation")} className={`px-2.5 py-1 rounded-md transition-colors ${presetTab === "resignation" ? "bg-card text-primary font-semibold shadow-xs" : "text-muted hover:text-ink"}`}>🚪 离职原因篇</button>
          <button type="button" onClick={() => setPresetTab("gap")} className={`px-2.5 py-1 rounded-md transition-colors ${presetTab === "gap" ? "bg-card text-accent font-semibold shadow-xs" : "text-muted hover:text-ink"}`}>⏳ 空窗期 / Gap 篇</button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {presets.map((preset) => {
          const selected = inspectPreset?.id === preset.id;
          return <button key={preset.id} type="button" onClick={() => setInspectPreset(selected ? null : preset)} className={`flex flex-col justify-between text-left p-3 rounded-xl border transition-all ${selected ? "border-primary bg-primary-soft/60 shadow-sm" : "border-line bg-surface hover:border-primary/50 hover:bg-surface-2"}`}>
            <div className="space-y-1"><div className="flex items-center justify-between"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${preset.category === "resignation" ? "bg-primary/15 text-primary" : "bg-accent/15 text-accent"}`}>{preset.category === "resignation" ? "离职原因" : "空窗 Gap"}</span><span className="text-[10px] text-faint font-mono">[{preset.badge}]</span></div><div className="text-xs font-semibold text-ink line-clamp-1">{preset.title}</div></div>
            <div className="pt-2 mt-2 border-t border-line/40 text-[11px] text-muted flex items-center justify-between"><span>查看高情商话术</span><span className="text-primary">{selected ? "▲" : "▼"}</span></div>
          </button>;
        })}
      </div>

      {inspectPreset && <div className={`mt-4 space-y-4 border-l-4 border-primary p-5 ${wellCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3"><div className="flex items-center gap-2.5"><span className="text-base font-bold text-ink">{inspectPreset.title}</span><span className={badgePrimary}>{inspectPreset.badge}</span></div><div className="flex items-center gap-3"><button type="button" onClick={() => onUsePreset(inspectPreset)} className="text-xs text-primary hover:underline font-medium">+ 填入下方定制输入框</button><button type="button" onClick={() => setInspectPreset(null)} className="text-xs text-faint hover:text-ink">收起 ✕</button></div></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs"><div className="rounded-lg border border-line bg-card p-3.5 space-y-1"><div className="font-semibold text-muted flex items-center gap-1.5"><span>💭 求职者的大实话痛点</span></div><p className="text-ink leading-relaxed">{inspectPreset.rawPain}</p></div><div className="rounded-lg border border-danger/25 bg-danger-wash p-3.5 space-y-1"><div className="font-semibold text-danger flex items-center gap-1.5"><span>🎯 HR 听到后的潜意识顾虑</span></div><p className="text-ink font-medium leading-relaxed">{inspectPreset.hrConcern}</p></div></div>
        <div className="rounded-lg border border-line bg-card p-3.5 space-y-1 text-xs"><div className="font-semibold text-ink flex items-center gap-1.5"><span>💡 高情商重塑核心抓手</span></div><p className="text-muted leading-relaxed">{inspectPreset.reframeAngle}</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs"><div className="rounded-lg border border-primary/20 bg-primary-soft/30 p-3.5 space-y-2 flex flex-col justify-between"><div className="space-y-1.5"><div className="flex items-center justify-between"><span className="font-semibold text-primary">⚡ 四两拨千斤（精炼 30 秒版）</span><button type="button" onClick={() => onCopy(inspectPreset.quickScript)} className="text-primary hover:underline font-medium">{copiedText === inspectPreset.quickScript ? "已复制 ✓" : "复制"}</button></div><p className="text-ink leading-relaxed font-sans">{inspectPreset.quickScript}</p></div><span className="text-[11px] text-faint">适合初面电话或快速过筛环节</span></div><div className="rounded-lg border border-line bg-card p-3.5 space-y-2 flex flex-col justify-between"><div className="space-y-1.5"><div className="flex items-center justify-between"><span className="font-semibold text-ink">📖 深度坦诚与正向赋能版（1 分钟版）</span><button type="button" onClick={() => onCopy(inspectPreset.deepScript)} className="text-primary hover:underline font-medium">{copiedText === inspectPreset.deepScript ? "已复制 ✓" : "复制"}</button></div><p className="text-muted leading-relaxed font-sans">{inspectPreset.deepScript}</p></div><span className="text-[11px] text-faint">适合业务主管深入追问心路历程</span></div></div>
        <div className="rounded-lg border border-danger/30 bg-danger-wash/60 p-3 text-xs flex items-start gap-2"><span className="text-danger font-semibold shrink-0">🚫 绝对禁忌红线：</span><span className="text-ink leading-relaxed">{inspectPreset.forbidden}</span></div>
      </div>}
    </div>
  );
}
