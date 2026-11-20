"use client";

import { CHALLENGE_MODES, CHALLENGE_OPTIONS, type ChallengeConditions } from "@/lib/evidence-challenge";
import { inputCls, labelCls } from "@/lib/ui";

export function ChallengeConditionsEditor({ value, onChange }: { value: ChallengeConditions; onChange: (value: ChallengeConditions) => void }) {
  return <div className="space-y-3">
    <label className={`${labelCls} block space-y-1`}>追问方式
      <select className={inputCls} value={value.mode} onChange={event => onChange({ ...value, mode: event.target.value as ChallengeConditions["mode"], change: "" })}>
        {CHALLENGE_MODES.map(mode => <option key={mode} value={mode}>{CHALLENGE_OPTIONS[mode].label}</option>)}
      </select>
    </label>
    <label className={`${labelCls} block space-y-1`}>原条件与约束（可留空）
      <input className={inputCls} maxLength={80} value={value.baseline} placeholder="例如：当前峰值、延迟目标、预算；未知可留空" onChange={event => onChange({ ...value, baseline: event.target.value })} />
    </label>
    {(value.mode === "alternative" || value.mode === "custom") && <label className={`${labelCls} block space-y-1`}>{value.mode === "alternative" ? "替代方案" : "变化后的条件"}
      <input className={inputCls} maxLength={100} value={value.change} placeholder={value.mode === "alternative" ? "例如：消息队列异步处理" : "例如：部署资源减半，延迟目标不变"} onChange={event => onChange({ ...value, change: event.target.value })} />
    </label>}
  </div>;
}
