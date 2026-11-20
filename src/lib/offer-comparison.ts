/** Pure, browser-safe calculations. All money uses the same user-selected currency;
 * amounts are annual, pre-tax estimates, never payroll or market predictions. */
export const SCENARIOS = [
  { key: "conservative", label: "保守" },
  { key: "neutral", label: "中性" },
  { key: "optimistic", label: "乐观" },
] as const;
export type ScenarioKey = (typeof SCENARIOS)[number]["key"];

export const OFFER_FIELDS = {
  monthlySalary: { label: "税前月固定工资", unit: "元 / 月", min: 0, max: 100000000, group: "income" },
  guaranteedMonths: { label: "保证发薪月数", unit: "月 / 年", min: 1, max: 24, group: "income" },
  annualAllowance: { label: "年度固定现金补贴", unit: "元 / 年", min: 0, max: 1000000000, group: "income" },
  annualBonus: { label: "年度目标浮动奖金", unit: "元 / 年", min: 0, max: 1000000000, group: "income" },
  annualEquity: { label: "年度归属权益估值", unit: "元 / 年", min: 0, max: 1000000000, group: "income" },
  weeklyHours: { label: "每周实际工时（含加班）", unit: "小时 / 周", min: 1, max: 168, group: "time" },
  workingWeeks: { label: "每年实际工作周数", unit: "周 / 年", min: 1, max: 52, group: "time" },
  onsiteDays: { label: "每周到岗天数", unit: "天 / 周", min: 0, max: 7, group: "time" },
  commuteMinutes: { label: "每日往返通勤", unit: "分钟 / 天", min: 0, max: 1440, group: "time" },
  monthlyCommuteCost: { label: "月均通勤支出", unit: "元 / 月", min: 0, max: 10000000, group: "time" },
  monthlyOtherCost: { label: "月均其他工作成本", unit: "元 / 月", min: 0, max: 10000000, group: "time" },
} as const;
export type OfferField = keyof typeof OFFER_FIELDS;
export type OfferValues = Record<OfferField, string>;
export const PREFERENCES = [
  { key: "growth", label: "成长与工作内容" },
  { key: "stability", label: "业务与岗位稳定性" },
  { key: "culture", label: "团队与管理方式" },
  { key: "flexibility", label: "地点与工作灵活性" },
] as const;
export type PreferenceKey = (typeof PREFERENCES)[number]["key"];
export type PreferenceWeights = Record<PreferenceKey, number>;
export type OfferDraft = {
  name: string;
  values: OfferValues;
  rates: Record<ScenarioKey, { bonus: string; equity: string }>;
  ratings: Record<PreferenceKey, number | null>;
  confirmed: { compensation: boolean; bonus: boolean; equity: boolean; schedule: boolean; costs: boolean };
};
export type OfferScenario = {
  fixedIncome: number;
  bonusIncome: number;
  cashIncome: number;
  equityValue: number;
  annualCosts: number;
  cashAfterCosts: number;
  referenceValue: number;
  annualWorkHours: number;
  annualCommuteHours: number;
  annualTotalHours: number;
  effectiveHourlyCash: number;
};
export type OfferAnalysis = {
  errors: Record<string, string>;
  scenarios: Record<ScenarioKey, OfferScenario> | null;
};

export function createOfferDraft(): OfferDraft {
  return {
    name: "",
    values: {
      monthlySalary: "", guaranteedMonths: "12", annualAllowance: "", annualBonus: "", annualEquity: "",
      weeklyHours: "40", workingWeeks: "48", onsiteDays: "5", commuteMinutes: "",
      monthlyCommuteCost: "", monthlyOtherCost: "",
    },
    rates: {
      conservative: { bonus: "0", equity: "0" },
      neutral: { bonus: "50", equity: "0" },
      optimistic: { bonus: "100", equity: "100" },
    },
    ratings: { growth: null, stability: null, culture: null, flexibility: null },
    confirmed: { compensation: false, bonus: false, equity: false, schedule: false, costs: false },
  };
}

function numeric(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function analyzeOffer(draft: OfferDraft): OfferAnalysis {
  const errors: Record<string, string> = {};
  const values = {} as Record<OfferField, number>;
  for (const key of Object.keys(OFFER_FIELDS) as OfferField[]) {
    const field = OFFER_FIELDS[key];
    const value = numeric(draft.values[key]);
    if (value === null || value < field.min || value > field.max) {
      errors[key] = draft.values[key].trim() ? `请输入 ${field.min}–${field.max} 之间的有限数字` : "待补充；没有此项请填 0";
    } else {
      values[key] = value;
    }
  }
  const rates = {} as Record<ScenarioKey, { bonus: number; equity: number }>;
  for (const scenario of SCENARIOS) {
    rates[scenario.key] = { bonus: 0, equity: 0 };
    for (const kind of ["bonus", "equity"] as const) {
      // Absent compensation does not require a rate; unknown compensation still blocks totals.
      if (values[kind === "bonus" ? "annualBonus" : "annualEquity"] === 0) continue;
      const value = numeric(draft.rates[scenario.key][kind]);
      const max = kind === "bonus" ? 300 : 100;
      if (value === null || value < 0 || value > max) errors[`${scenario.key}.${kind}`] = `请输入 0–${max} 之间的比例`;
      else rates[scenario.key][kind] = value / 100;
    }
  }
  for (const kind of ["bonus", "equity"] as const) {
    if (rates.conservative[kind] > rates.neutral[kind] || rates.neutral[kind] > rates.optimistic[kind]) {
      errors[`order.${kind}`] = `${kind === "bonus" ? "奖金兑现" : "权益计入"}比例应满足：保守 ≤ 中性 ≤ 乐观`;
    }
  }
  const weeklyCommuteHours = values.onsiteDays * values.commuteMinutes / 60;
  if (values.weeklyHours + weeklyCommuteHours > 168) errors.commuteMinutes = "每周工时与通勤合计不能超过 168 小时";
  if (Object.keys(errors).length) return { errors, scenarios: null };

  const fixedIncome = values.monthlySalary * values.guaranteedMonths + values.annualAllowance;
  const annualCosts = (values.monthlyCommuteCost + values.monthlyOtherCost) * 12;
  const annualWorkHours = values.weeklyHours * values.workingWeeks;
  const annualCommuteHours = weeklyCommuteHours * values.workingWeeks;
  const annualTotalHours = annualWorkHours + annualCommuteHours;
  const scenarios = {} as Record<ScenarioKey, OfferScenario>;
  for (const { key } of SCENARIOS) {
    const bonusIncome = values.annualBonus * rates[key].bonus;
    const equityValue = values.annualEquity * rates[key].equity;
    const cashIncome = fixedIncome + bonusIncome;
    const cashAfterCosts = cashIncome - annualCosts;
    scenarios[key] = {
      fixedIncome, bonusIncome, cashIncome, equityValue, annualCosts, cashAfterCosts,
      referenceValue: cashAfterCosts + equityValue,
      annualWorkHours, annualCommuteHours, annualTotalHours,
      effectiveHourlyCash: cashAfterCosts / annualTotalHours,
    };
  }
  return { errors, scenarios };
}

export function preferenceScore(offer: OfferDraft, weights: PreferenceWeights): number | null {
  let totalWeight = 0;
  let score = 0;
  for (const { key } of PREFERENCES) {
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight < 0 || weight > 5) return null;
    if (weight === 0) continue;
    const rating = offer.ratings[key];
    if (rating === null || !Number.isInteger(rating) || rating < 1 || rating > 5) return null;
    score += rating * weight;
    totalWeight += weight;
  }
  return totalWeight ? score / (totalWeight * 5) * 100 : null;
}

export function hrQuestions(offer: OfferDraft): string[] {
  const questions: string[] = [];
  if (!offer.confirmed.compensation) {
    questions.push("请书面确认月固定工资、保证发薪月数及固定补贴；额外薪数是否附带绩效或在职条件？试用期是否折薪，首年是否按入职日期折算？");
  }
  if (!offer.confirmed.bonus && numeric(offer.values.annualBonus) !== 0) {
    questions.push("年度目标奖金按什么基数和绩效档位计算？请提供团队过去几年的实际兑现范围、发放时间，以及首年和离职时的发放条件。");
  }
  if (!offer.confirmed.equity && numeric(offer.values.annualEquity) !== 0) {
    questions.push("权益的授予数量、估值依据、年度归属安排、等待期及行权成本是什么？是否有可执行的变现渠道，离职后如何处理？请区分授予总额与当年归属额。");
  }
  if (!offer.confirmed.schedule) {
    questions.push("团队通常每周实际工作多久，是否有晚间、周末加班或值班？加班补偿、可休假天数、每周到岗要求与办公地点能否书面确认？");
  }
  if (!offer.confirmed.costs) {
    questions.push("通勤、餐食、住宿或搬迁有哪些补贴和报销，是否已包含在薪酬包内？哪些支出需个人承担？请确认社保、公积金和其他扣款口径。");
  }
  for (const { key, label } of PREFERENCES) {
    if (offer.ratings[key] !== null && offer.ratings[key]! >= 3) continue;
    const prompts: Record<PreferenceKey, string> = {
      growth: "岗位入职后的具体职责、前三个月目标、培训资源与晋升评估标准是什么？",
      stability: "这个岗位的招聘原因、所属团队的业务规划和试用期考核标准是什么？",
      culture: "直接汇报对象是谁，团队如何分工、反馈和处理优先级冲突？能否与未来主管进一步交流？",
      flexibility: "远程办公、弹性上下班和工作地点有哪些约定？这些安排是否可能变动？",
    };
    questions.push(`关于${label}：${prompts[key]}`);
  }
  return questions;
}

export function createExampleOffers(): [OfferDraft, OfferDraft] {
  const a = createOfferDraft();
  const b = createOfferDraft();
  a.name = "高现金方案（示例）";
  b.name = "生活平衡方案（示例）";
  a.values = {
    monthlySalary: "30000", guaranteedMonths: "13", annualAllowance: "12000", annualBonus: "90000", annualEquity: "60000",
    weeklyHours: "50", workingWeeks: "48", onsiteDays: "5", commuteMinutes: "90", monthlyCommuteCost: "800", monthlyOtherCost: "1200",
  };
  b.values = {
    monthlySalary: "28000", guaranteedMonths: "13", annualAllowance: "12000", annualBonus: "56000", annualEquity: "0",
    weeklyHours: "40", workingWeeks: "48", onsiteDays: "3", commuteMinutes: "40", monthlyCommuteCost: "300", monthlyOtherCost: "700",
  };
  a.ratings = { growth: 5, stability: 3, culture: 3, flexibility: 2 };
  b.ratings = { growth: 3, stability: 4, culture: 4, flexibility: 5 };
  return [a, b];
}
