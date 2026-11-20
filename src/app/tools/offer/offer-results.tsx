import { SCENARIOS, type OfferDraft, type OfferAnalysis, type OfferScenario, type ScenarioKey } from "@/lib/offer-comparison";
import { cardCls, btnGhost } from "@/lib/ui";

const number = (value: number, digits = 0) => value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const money = (value: number) => `${number(value, 2)} 元`;
export const offerName = (offer: OfferDraft, index: number) => `Offer ${index === 0 ? "A" : "B"}${offer.name.trim() ? ` · ${offer.name.trim()}` : ""}`;

export function OfferResults({ offers, analyses, scores, scenario, onScenarioChange }: {
  offers: [OfferDraft, OfferDraft];
  analyses: [OfferAnalysis, OfferAnalysis];
  scores: [number | null, number | null];
  scenario: ScenarioKey;
  onScenarioChange: (scenario: ScenarioKey) => void;
}) {
  const results = analyses.map(analysis => analysis.scenarios?.[scenario] ?? null);
  const [a, b] = results;
  const cashDiff = a && b ? a.cashAfterCosts - b.cashAfterCosts : null;
  const hoursDiff = a && b ? a.annualTotalHours - b.annualTotalHours : null;
  const hourlyDiff = a && b ? a.effectiveHourlyCash - b.effectiveHourlyCash : null;
  const metrics: { key: keyof OfferScenario; label: string; unit: "money" | "hours" | "hourly" }[] = [
    { key: "fixedIncome", label: "年度固定收入", unit: "money" },
    { key: "bonusIncome", label: "情景浮动奖金", unit: "money" },
    { key: "cashIncome", label: "年度税前现金", unit: "money" },
    { key: "annualCosts", label: "年度自付工作成本", unit: "money" },
    { key: "cashAfterCosts", label: "成本后现金（税前）", unit: "money" },
    { key: "equityValue", label: "权益参考估值（非现金）", unit: "money" },
    { key: "referenceValue", label: "含权益参考总值", unit: "money" },
    { key: "annualWorkHours", label: "年度工作时间", unit: "hours" },
    { key: "annualCommuteHours", label: "年度通勤时间", unit: "hours" },
    { key: "annualTotalHours", label: "年度总投入时间", unit: "hours" },
    { key: "effectiveHourlyCash", label: "有效现金时薪", unit: "hourly" },
  ];
  return <section className={`${cardCls} space-y-5 p-4 sm:p-6`} aria-label="比较结果">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-serif text-lg font-bold">情景比较</h2>
      <div className="flex gap-2" role="group" aria-label="查看情景">
        {SCENARIOS.map(({ key, label }) => <button key={key} type="button" aria-pressed={scenario === key}
          className={`${btnGhost} ${scenario === key ? "border-primary bg-primary-soft text-primary" : ""}`}
          onClick={() => onScenarioChange(key)}>{label}</button>)}
      </div>
    </div>
    <div className="grid gap-3 md:grid-cols-3">
      {SCENARIOS.map(({ key, label }) => <div key={key} className={`space-y-2 rounded-xl border p-4 ${scenario === key ? "border-primary/40 bg-primary-soft/40" : "border-line bg-surface"}`}>
        <h3 className="font-bold">{label}<span className="ml-2 text-xs font-normal text-muted">成本后现金 / 年</span></h3>
        {offers.map((offer, index) => <div key={index} className="flex flex-wrap justify-between gap-x-3 text-sm">
          <span className="min-w-0 break-words text-muted" title={offerName(offer, index)}>Offer {index === 0 ? "A" : "B"}</span>
          <span className="font-mono">{analyses[index]?.scenarios ? money(analyses[index]!.scenarios![key].cashAfterCosts) : "待补充"}</span>
        </div>)}
      </div>)}
    </div>
    {a && b && cashDiff !== null && hoursDiff !== null && hourlyDiff !== null ? <div className="space-y-2 rounded-lg bg-surface p-4 text-sm" aria-live="polite">
      <p className="font-medium">{SCENARIOS.find(item => item.key === scenario)?.label}情景下的取舍</p>
      <p>{Math.abs(cashDiff) < 0.005 ? "两份 Offer 的年度成本后现金相同。" : `${cashDiff > 0 ? "Offer A" : "Offer B"} 每年成本后现金多 ${money(Math.abs(cashDiff))}。`}
        {Math.abs(hoursDiff) < 0.005 ? "两者时间投入相同。" : `${hoursDiff > 0 ? "Offer A" : "Offer B"} 每年多投入 ${number(Math.abs(hoursDiff), 1)} 小时（含通勤）。`}</p>
      <p>{Math.abs(hourlyDiff) < 0.005 ? "两者有效现金时薪相同。" : `按有效现金时薪，${hourlyDiff > 0 ? "Offer A" : "Offer B"} 更高，相差 ${money(Math.abs(hourlyDiff))} / 小时。`}</p>
      <p className="text-xs text-muted">结合下方个人偏好与待确认条件再做选择；权益估值单列，不计入现金时薪。</p>
    </div> : <p className="rounded-lg bg-surface p-4 text-sm text-muted">补齐两份 Offer 的收入与时间条件后显示取舍分析。未知项保持空白；确认没有的项目填 0。</p>}
    <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="Offer 指标对照表">
      <table className="w-full min-w-[520px] text-left text-sm">
        <caption className="sr-only">{SCENARIOS.find(item => item.key === scenario)?.label}情景的年度收入和时间对照</caption>
        <thead className="bg-surface"><tr><th scope="col" className="p-3">比较维度</th>{offers.map((offer, index) => <th key={index} scope="col" className="max-w-60 break-words p-3">{offerName(offer, index)}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">
          {metrics.map(metric => <tr key={metric.key} className={metric.key === "effectiveHourlyCash" || metric.key === "cashAfterCosts" ? "bg-primary-soft/40 font-medium" : ""}>
            <th scope="row" className="p-3 font-normal">{metric.label}</th>
            {results.map((result, index) => <td key={index} className="p-3 font-mono">{!result ? "待补充" : metric.unit === "hours"
              ? `${number(result[metric.key], 1)} 小时` : `${money(result[metric.key])}${metric.unit === "hourly" ? " / 小时" : ""}`}</td>)}
          </tr>)}
          <tr><th scope="row" className="p-3 font-normal">个人偏好匹配（独立评分）</th>{scores.map((score, index) => <td key={index} className="p-3 font-mono">{score === null ? "待设置" : `${number(score, 1)} / 100`}</td>)}</tr>
        </tbody>
      </table>
    </div>
    <details className="text-xs text-muted">
      <summary className="cursor-pointer font-medium text-ink">计算口径与公式</summary>
      <ul className="mt-3 list-disc space-y-2 pl-5 leading-relaxed">
        <li>年度固定收入 = 月固定工资 × 保证薪数 + 年度固定现金补贴；浮动奖金 = 年度目标奖金 × 该情景兑现比例。</li>
        <li>成本后现金 = 固定收入 + 浮动奖金 − 12 ×（月均通勤支出 + 月均其他工作成本）。这是税前比较值，未扣个税、社保、公积金，不是到手工资。</li>
        <li>含权益参考总值 = 成本后现金 + 年度归属权益估值 × 该情景计入比例。权益不保证变现，也未估算行权费用。</li>
        <li>年度总时间 = 实际工作周数 ×（每周工时 + 每周到岗天数 × 每日往返通勤分钟 ÷ 60）；有效现金时薪 = 成本后现金 ÷ 年度总时间。</li>
        <li>采用完整工作年度的经常性收入，不含签字费等一次性收入；试用期折薪、入职不足一年等情况需另行核实。所有金额请使用人民币同一口径。</li>
        <li>偏好匹配 = Σ（评分 × 权重）÷（5 × 总权重）× 100。只含非零权重项；任何参与项待评估时不输出总分。偏好分不与现金金额混加。</li>
      </ul>
    </details>
  </section>;
}
