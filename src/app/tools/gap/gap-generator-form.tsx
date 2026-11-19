"use client";

import type { PersonaStyle, ScenarioType } from "@/lib/career-gap-remedy";
import { btnPrimary, cardCls, inputCls, textareaTallCls, labelCls } from "@/lib/ui";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { SAMPLE_STORIES } from "./gap-helpers";

type GapGeneratorFormProps = {
  scenarioType: ScenarioType;
  rawStory: string;
  targetRole: string;
  personaStyle: PersonaStyle;
  submitting: boolean;
  creationBlocked?: boolean;
  setScenarioType: (value: ScenarioType) => void;
  setRawStory: (value: string) => void;
  setTargetRole: (value: string) => void;
  setPersonaStyle: (value: PersonaStyle) => void;
  onGenerate: () => void;
};

export function GapGeneratorForm({ scenarioType, rawStory, targetRole, personaStyle, submitting, creationBlocked = false, setScenarioType, setRawStory, setTargetRole, setPersonaStyle, onGenerate }: GapGeneratorFormProps) {
  function fillSample(type: ScenarioType) {
    setScenarioType(type);
    setRawStory(SAMPLE_STORIES[type].text);
  }

  return <div className={`relative p-5 sm:p-6 space-y-5 ${cardCls}`}>
    <LoadingOverlay
      show={submitting}
      message="正在整理沟通方案…"
      description="根据已提供的经历整理 3 套表达方式与可能的追问，未确定的内容会保留待补充。"
    />
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3"><div><h2 className="text-sm font-bold text-ink flex items-center gap-2"><span>✨ AI 定制沟通方案</span></h2><p className="text-xs text-muted mt-0.5">根据真实经历整理 3 套表达方式与可能的追问。示例仅供参考，生成前请改成自己的情况。</p></div><div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted">填入示例：</span><button type="button" disabled={submitting} onClick={() => fillSample("resignation")} className="text-xs text-primary hover:underline">加班内耗</button><span className="text-xs text-faint">·</span><button type="button" disabled={submitting} onClick={() => fillSample("gap")} className="text-xs text-primary hover:underline">休整学习4个月</button><span className="text-xs text-faint">·</span><button type="button" disabled={submitting} onClick={() => fillSample("both")} className="text-xs text-primary hover:underline">业务被裁+待业</button></div></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <fieldset className="min-w-0 space-y-1.5"><legend className={labelCls}>沟通场景</legend><div className="flex gap-2">{[{ id: "both", label: "两者兼有 / 综合" }, { id: "resignation", label: "🚪 仅离职原因" }, { id: "gap", label: "⏳ 仅空窗期 Gap" }].map((item) => <button key={item.id} type="button" disabled={submitting} aria-pressed={scenarioType === item.id} onClick={() => setScenarioType(item.id as ScenarioType)} className={`flex-1 rounded-lg border py-2 text-xs font-medium transition-colors ${scenarioType === item.id ? "border-primary bg-primary-soft text-primary font-semibold" : "border-line bg-surface text-muted hover:text-ink"}`}>{item.label}</button>)}</div></fieldset>
      <fieldset className="min-w-0 space-y-1.5"><legend className={labelCls}>表达风格（仅调整语气与组织）</legend><div className="flex gap-2">{[{ id: "pragmatic", label: "🛡️ 务实稳健型" }, { id: "driven", label: "🚀 自驱进取型" }, { id: "composed", label: "☕ 从容睿智型" }].map((item) => <button key={item.id} type="button" disabled={submitting} aria-pressed={personaStyle === item.id} onClick={() => setPersonaStyle(item.id as PersonaStyle)} className={`flex-1 rounded-lg border py-2 text-xs font-medium transition-colors ${personaStyle === item.id ? "border-primary bg-primary-soft text-primary font-semibold" : "border-line bg-surface text-muted hover:text-ink"}`}><div>{item.label}</div></button>)}</div></fieldset>
    </div>
    <label className="block"><span className={labelCls}>目标应聘岗位 / 业务方向（选填）</span><input type="text" disabled={submitting} className={`${inputCls} mt-1.5`} placeholder="例如：前端工程师、Java 后台开发、产品经理等，按实际求职方向填写" value={targetRole} onChange={(event) => setTargetRole(event.target.value)} /></label>
    <div className="block">
      <div className="flex items-center justify-between">
        <label htmlFor="gap-raw-story" className={labelCls}>真实经历与希望说明的问题</label>
        {rawStory.trim() && <button type="button" disabled={submitting} onClick={() => setRawStory("")} className="text-xs text-faint hover:text-danger">清空内容</button>}
      </div>
      <textarea id="gap-raw-story" disabled={submitting} className={`${textareaTallCls} mt-1.5 text-xs font-mono`} value={rawStory} onChange={(event) => setRawStory(event.target.value)} placeholder="请说明离职或空窗的实际原因、时间，以及已确定和仍待确认的安排。例如：休息两个月，没有学习或项目；全职备考一年未通过，是否再考尚未决定。只填写愿意披露且与沟通有关的信息。" />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2"><div className="text-xs text-muted">{rawStory.trim().length > 0 ? <span>已输入 {rawStory.trim().length} 字，请确认内容符合真实情况</span> : <span>按事实整理表达，未知内容可保留待补充</span>}</div><button type="button" className={btnPrimary} onClick={onGenerate} disabled={submitting || creationBlocked || !rawStory.trim()}>{submitting ? "正在生成沟通方案…" : "生成沟通方案 →"}</button></div>
  </div>;
}
