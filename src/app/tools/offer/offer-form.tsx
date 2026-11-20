import { inputCls, labelCls, cardCls } from "@/lib/ui";
import { OFFER_FIELDS, SCENARIOS, type OfferDraft, type OfferField, type OfferAnalysis } from "@/lib/offer-comparison";

export function OfferForm({ id, offer, onChange, analysis, showErrors }: {
  id: string;
  offer: OfferDraft;
  onChange: (offer: OfferDraft) => void;
  analysis: OfferAnalysis;
  showErrors: boolean;
}) {
  return (
    <section className={`${cardCls} min-w-0 space-y-5 p-4 sm:p-6`} aria-label={`Offer ${id} 条件`}>
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft font-mono font-bold text-primary">{id}</span>
        <label className="min-w-0 flex-1 space-y-1">
          <span className={labelCls}>Offer {id} 名称（选填）</span>
          <input className={inputCls} maxLength={80} placeholder="公司 / 岗位 / 方案名称" value={offer.name} onChange={event => onChange({ ...offer, name: event.target.value })} />
        </label>
      </div>
      {(["income", "time"] as const).map(group => (
        <fieldset key={group} className="space-y-3 border-t border-line pt-4">
          <legend className="pr-2 font-serif text-sm font-bold">{group === "income" ? "收入构成" : "工时、通勤与支出"}</legend>
          <p className="text-xs leading-relaxed text-muted">{group === "income"
            ? "保证薪数只含固定部分；浮动年终奖单列，避免重复。权益填写当年归属估值。"
            : "工作周数扣除休假；工时不含通勤。支出按全年月均填写，其他成本可含额外房租、餐食。"}</p>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            {(Object.keys(OFFER_FIELDS) as OfferField[]).filter(key => OFFER_FIELDS[key].group === group).map(key => {
              const field = OFFER_FIELDS[key];
              const error = showErrors ? analysis.errors[key] : undefined;
              const inputId = `offer-${id}-${key}`;
              return <div key={key} className="min-w-0 space-y-1.5">
                <label htmlFor={inputId} className={labelCls}>{field.label}</label>
                <input id={inputId} type="number" inputMode="decimal" step="any" min={field.min} max={field.max}
                  className={inputCls} value={offer.values[key]} placeholder="待补充" aria-invalid={!!error}
                  aria-describedby={`${inputId}-hint`} onChange={event => onChange({ ...offer, values: { ...offer.values, [key]: event.target.value } })} />
                <p id={`${inputId}-hint`} className={`text-xs ${error ? "text-danger" : "text-muted"}`}>{error || field.unit}</p>
              </div>;
            })}
          </div>
        </fieldset>
      ))}
      <details className="rounded-lg border border-line bg-surface p-3">
        <summary className="cursor-pointer text-sm font-medium">调整三种情景的兑现假设</summary>
        <p className="my-3 text-xs leading-relaxed text-muted">奖金默认 0% / 50% / 100%；权益默认 0% / 0% / 100%。它们是可修改的测算假设，非兑现概率。工时与支出在三种情景中保持一致。</p>
        <div className="space-y-3">
          {SCENARIOS.map(({ key, label }) => <fieldset key={key} className="grid grid-cols-2 gap-3">
            <legend className="mb-1 text-xs font-bold">{label}</legend>
            {(["bonus", "equity"] as const).map(kind => {
              const inputId = `offer-${id}-${key}-${kind}`;
              const error = showErrors ? analysis.errors[`${key}.${kind}`] : undefined;
              return <div key={kind} className="space-y-1">
                <label htmlFor={inputId} className={labelCls}>{label}{kind === "bonus" ? "奖金兑现" : "权益计入"}（%）</label>
                <input id={inputId} className={inputCls} type="number" step="any" min={0} max={kind === "bonus" ? 300 : 100}
                  value={offer.rates[key][kind]} aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : undefined}
                  onChange={event => onChange({ ...offer, rates: { ...offer.rates, [key]: { ...offer.rates[key], [kind]: event.target.value } } })} />
                {error && <p id={`${inputId}-error`} className="text-xs text-danger">{error}</p>}
              </div>;
            })}
          </fieldset>)}
        </div>
      </details>
      {showErrors && Object.entries(analysis.errors).filter(([key]) => key.includes(".")).length > 0 &&
        <p role="alert" className="text-xs text-danger">请展开兑现假设并检查比例。{analysis.errors["order.bonus"]} {analysis.errors["order.equity"]}</p>}
      <fieldset className="space-y-2 border-t border-line pt-3">
        <legend className="pr-2 text-sm font-medium">已向 HR 核实的条件</legend>
        <p className="text-xs text-muted">勾选后从待确认清单移除；不改变计算数值。</p>
        {([
          ["compensation", "固定工资、薪数与补贴"], ["bonus", "奖金兑现与发放条件"], ["equity", "权益归属与变现条件"],
          ["schedule", "实际工时、休假与到岗安排"], ["costs", "自付成本、报销与扣款口径"],
        ] as const).map(([key, label]) => <label key={key} className="flex items-start gap-2 text-xs text-muted">
          <input type="checkbox" className="mt-0.5 accent-primary" checked={offer.confirmed[key]}
            onChange={event => onChange({ ...offer, confirmed: { ...offer.confirmed, [key]: event.target.checked } })} />{label}
        </label>)}
      </fieldset>
    </section>
  );
}
