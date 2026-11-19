"use client";

import type { PresetRemedy } from "@/lib/career-gap-remedy";
import { badgePrimary, cardCls, wellCls } from "@/lib/ui";
import type { PresetTab } from "./gap-helpers";

type GapPresetLibraryProps = {
  presetTab: PresetTab;
  presets: PresetRemedy[];
  inspectPreset: PresetRemedy | null;
  copiedText: string | null;
  copyError: { text: string; message: string } | null;
  copying: boolean;
  inputLocked?: boolean;
  setPresetTab: (tab: PresetTab) => void;
  setInspectPreset: (preset: PresetRemedy | null) => void;
  onUsePreset: (preset: PresetRemedy) => void;
  onCopy: (text: string) => void;
};

export function GapPresetLibrary({ presetTab, presets, inspectPreset, copiedText, copyError, copying, inputLocked = false, setPresetTab, setInspectPreset, onUsePreset, onCopy }: GapPresetLibraryProps) {
  return (
    <div className={`p-5 space-y-4 ${cardCls}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3">
        <div><h2 className="text-sm font-bold text-ink flex items-center gap-2"><span>📚 离职与空窗沟通示例</span><span className="text-xs font-normal text-muted">（查看可能追问、表达思路与示例）</span></h2></div>
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
            <div className="pt-2 mt-2 border-t border-line/40 text-[11px] text-muted flex items-center justify-between"><span>查看沟通示例</span><span className="text-primary">{selected ? "▲" : "▼"}</span></div>
          </button>;
        })}
      </div>

      {inspectPreset && <div className={`mt-4 space-y-4 border-l-4 border-primary p-5 ${wellCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3"><div className="flex flex-wrap items-center gap-2.5"><span className="text-base font-bold text-ink">{inspectPreset.title}</span><span className={badgePrimary}>{inspectPreset.badge}</span></div><div className="flex items-center gap-3"><button type="button" disabled={inputLocked} onClick={() => onUsePreset(inspectPreset)} className="text-xs text-primary hover:underline font-medium">+ 填入示例后修改</button><button type="button" onClick={() => setInspectPreset(null)} className="text-xs text-faint hover:text-ink">收起 ✕</button></div></div>
        <p className="text-xs text-muted leading-relaxed">以下是场景示例。使用前请改成自己的真实经历，填写或删除“待补充”部分，保留尚未确认的条件。</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs"><div className="rounded-lg border border-line bg-card p-3.5 space-y-1"><div className="font-semibold text-muted flex items-center gap-1.5"><span>💭 示例中的已知情况</span></div><p className="text-ink leading-relaxed">{inspectPreset.rawPain}</p></div><div className="rounded-lg border border-danger/25 bg-danger-wash p-3.5 space-y-1"><div className="font-semibold text-danger flex items-center gap-1.5"><span>🎯 招聘方可能核实的信息</span></div><p className="text-ink font-medium leading-relaxed">{inspectPreset.hrConcern}</p></div></div>
        <div className="rounded-lg border border-line bg-card p-3.5 space-y-1 text-xs"><div className="font-semibold text-ink flex items-center gap-1.5"><span>💡 表达思路与事实边界</span></div><p className="text-muted leading-relaxed">{inspectPreset.reframeAngle}</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
          {[
            { label: "精炼说明示例", text: inspectPreset.quickScript, hint: "适合初步沟通离职或空窗情况" },
            { label: "详细说明示例", text: inspectPreset.deepScript, hint: "适合进一步说明事实与岗位相关安排" },
          ].map(({ label, text, hint }, index) => (
            <section key={label} aria-label={label} className={`rounded-lg border p-3.5 space-y-2 flex flex-col justify-between ${index === 0 ? "border-primary/20 bg-primary-soft/30" : "border-line bg-card"}`}>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`font-semibold ${index === 0 ? "text-primary" : "text-ink"}`}>{index === 0 ? "⚡" : "📖"} {label}</span>
                  <button type="button" disabled={copying} onClick={() => onCopy(text)} className="text-primary hover:underline font-medium disabled:opacity-50">{copiedText === text ? "已复制 ✓" : "复制示例"}</button>
                </div>
                <p className={`leading-relaxed font-sans whitespace-pre-wrap ${index === 0 ? "text-ink" : "text-muted"}`}>{text}</p>
                {copyError?.text === text && <p role="alert" className="text-danger">{copyError.message}</p>}
              </div>
              <span className="text-[11px] text-faint">{hint}</span>
            </section>
          ))}
        </div>
        <div className="rounded-lg border border-danger/30 bg-danger-wash/60 p-3 text-xs flex items-start gap-2"><span className="text-danger font-semibold shrink-0">表达注意：</span><span className="text-ink leading-relaxed">{inspectPreset.forbidden}</span></div>
      </div>}
    </div>
  );
}
