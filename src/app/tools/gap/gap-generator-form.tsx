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
  setScenarioType: (value: ScenarioType) => void;
  setRawStory: (value: string) => void;
  setTargetRole: (value: string) => void;
  setPersonaStyle: (value: PersonaStyle) => void;
  onGenerate: () => void;
};

export function GapGeneratorForm({ scenarioType, rawStory, targetRole, personaStyle, submitting, setScenarioType, setRawStory, setTargetRole, setPersonaStyle, onGenerate }: GapGeneratorFormProps) {
  function fillSample(type: ScenarioType) {
    setScenarioType(type);
    setRawStory(SAMPLE_STORIES[type].text);
  }

  return <div className={`relative p-5 sm:p-6 space-y-5 ${cardCls}`}>
    <LoadingOverlay
      show={submitting}
      message="高情商艺术重塑引擎正在全方位分析推演…"
      description="正在拆解面试官心理底线，深度构建 3 套量身定制的破局自辩预案与连环追杀应对，约需 15-20 秒，请稍候…"
    />
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 pb-3"><div><h2 className="text-sm font-bold text-ink flex items-center gap-2"><span>✨ AI 定制化高情商重塑引擎</span></h2><p className="text-xs text-muted mt-0.5">输入您的真实遭遇大实话，AI 将为您拆解 HR 心理、量身输出 3 套合规舒适的实战话术与连环追杀问答对策。</p></div><div className="flex items-center gap-2"><span className="text-xs text-muted">填入示例：</span><button type="button" onClick={() => fillSample("resignation")} className="text-xs text-primary hover:underline">加班内耗</button><span className="text-xs text-faint">·</span><button type="button" onClick={() => fillSample("gap")} className="text-xs text-primary hover:underline">裸辞充电4个月</button><span className="text-xs text-faint">·</span><button type="button" onClick={() => fillSample("both")} className="text-xs text-primary hover:underline">业务被裁+待业</button></div></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="space-y-1.5"><label className={labelCls}>重塑场景类型</label><div className="flex gap-2">{[{ id: "both", label: "两者兼有 / 综合" }, { id: "resignation", label: "🚪 仅离职原因" }, { id: "gap", label: "⏳ 仅空窗期 Gap" }].map((item) => <button key={item.id} type="button" onClick={() => setScenarioType(item.id as ScenarioType)} className={`flex-1 rounded-lg border py-2 text-xs font-medium transition-colors ${scenarioType === item.id ? "border-primary bg-primary-soft text-primary font-semibold" : "border-line bg-surface text-muted hover:text-ink"}`}>{item.label}</button>)}</div></div>
      <div className="space-y-1.5"><label className={labelCls}>期望展现的人设风格</label><div className="flex gap-2">{[{ id: "pragmatic", label: "🛡️ 务实稳健型" }, { id: "driven", label: "🚀 自驱进取型" }, { id: "composed", label: "☕ 从容睿智型" }].map((item) => <button key={item.id} type="button" onClick={() => setPersonaStyle(item.id as PersonaStyle)} className={`flex-1 rounded-lg border py-2 text-xs font-medium transition-colors ${personaStyle === item.id ? "border-primary bg-primary-soft text-primary font-semibold" : "border-line bg-surface text-muted hover:text-ink"}`}><div>{item.label}</div></button>)}</div></div>
    </div>
    <label className="block"><span className={labelCls}>目标应聘岗位 / 业务方向（选填）</span><input type="text" className={`${inputCls} mt-1.5`} placeholder="例如：资深前端工程师、Java 后台开发、产品专家、金融科技业务等（有助于将求职动机与目标岗位紧密绑定）" value={targetRole} onChange={(event) => setTargetRole(event.target.value)} /></label>
    <label className="block"><div className="flex items-center justify-between"><span className={labelCls}>真实经历与敏感痛点（大实话描述）</span>{rawStory.trim() && <button type="button" onClick={() => setRawStory("")} className="text-xs text-faint hover:text-danger">清空内容</button>}</div><textarea className={`${textareaTallCls} mt-1.5 text-xs font-mono`} value={rawStory} onChange={(event) => setRawStory(event.target.value)} placeholder="请放心倒苦水！越真实越好：比如‘因为天天陪领导应酬被逼离职’、‘考研考公没上岸在家待了9个月’、‘前司发不出工资裁员了’、‘跟直接上级管理理念不合闹掰了’等。AI 将把这些负面经历进行合法合规的高情商艺术重塑…" /></label>
    <div className="flex flex-wrap items-center justify-between gap-3 pt-2"><div className="text-xs text-muted">{rawStory.trim().length > 0 ? <span>已输入 {rawStory.trim().length} 字，将全方位解构重塑</span> : <span>支持如实描述，AI 绝对保密并严格输出高分话术</span>}</div><button type="button" className={btnPrimary} onClick={onGenerate} disabled={submitting || !rawStory.trim()}>{submitting ? "正在进行高情商艺术重塑中（约需20秒）…" : "启动高情商重塑引擎 →"}</button></div>
  </div>;
}
