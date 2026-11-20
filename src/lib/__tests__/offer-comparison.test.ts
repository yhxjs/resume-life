import { describe, expect, it } from "vitest";
import { analyzeOffer, createExampleOffers, createOfferDraft, hrQuestions, preferenceScore, type OfferField } from "../offer-comparison";

describe("Offer 年度价值测算", () => {
  it("分离固定现金、浮动奖金、权益和成本，以工作及通勤总时间计算时薪", () => {
    const [offer] = createExampleOffers();
    const result = analyzeOffer(offer);
    expect(result.errors).toEqual({});
    expect(result.scenarios!.neutral).toEqual({
      fixedIncome: 402000, bonusIncome: 45000, cashIncome: 447000, equityValue: 0,
      annualCosts: 24000, cashAfterCosts: 423000, referenceValue: 423000,
      annualWorkHours: 2400, annualCommuteHours: 360, annualTotalHours: 2760,
      effectiveHourlyCash: 423000 / 2760,
    });
    expect(result.scenarios!.conservative.cashAfterCosts).toBe(378000);
    expect(result.scenarios!.optimistic.cashAfterCosts).toBe(468000);
    expect(result.scenarios!.optimistic.referenceValue).toBe(528000);
    expect(result.scenarios!.optimistic.effectiveHourlyCash).toBe(468000 / 2760);
  });

  it("两份 Offer 使用独立比例，支持超额奖金且不变动固定收入", () => {
    const [a, b] = createExampleOffers();
    a.rates.neutral.bonus = "80";
    a.rates.optimistic.bonus = "150";
    a.rates.neutral.equity = "25";
    expect(analyzeOffer(a).scenarios!.neutral.bonusIncome).toBe(72000);
    expect(analyzeOffer(a).scenarios!.optimistic.bonusIncome).toBe(135000);
    expect(analyzeOffer(a).scenarios!.neutral.equityValue).toBe(15000);
    expect(analyzeOffer(b).scenarios!.neutral.bonusIncome).toBe(28000);
  });

  it("缺失值与确认没有区分，空值不静默作为 0", () => {
    const draft = createOfferDraft();
    expect(analyzeOffer(draft).scenarios).toBeNull();
    expect(analyzeOffer(draft).errors.monthlySalary).toContain("待补充");
    const [offer] = createExampleOffers();
    offer.values.annualBonus = "";
    expect(analyzeOffer(offer).scenarios).toBeNull();
    offer.values.annualBonus = "0";
    offer.rates.neutral.bonus = "";
    expect(analyzeOffer(offer).scenarios!.neutral.bonusIncome).toBe(0);
  });

  it.each<[OfferField, string]>([
    ["monthlySalary", "NaN"], ["monthlySalary", "Infinity"], ["monthlySalary", "-1"], ["annualBonus", "1e309"],
    ["monthlySalary", "100000001"], ["weeklyHours", "0"], ["workingWeeks", "53"], ["onsiteDays", "8"],
    ["commuteMinutes", "-5"], ["guaranteedMonths", "0"], ["monthlyOtherCost", "   "],
  ])("拒绝无效的 %s=%s", (field, value) => {
    const [offer] = createExampleOffers();
    offer.values[field] = value;
    const result = analyzeOffer(offer);
    expect(result.errors[field]).toBeTruthy();
    expect(result.scenarios).toBeNull();
  });

  it("拒绝反向、越界或缺失的情景比例及不可能的周总时间", () => {
    const [offer] = createExampleOffers();
    offer.rates.conservative.bonus = "90";
    expect(analyzeOffer(offer).errors["order.bonus"]).toBeTruthy();
    offer.rates.conservative.bonus = "0";
    offer.rates.optimistic.equity = "101";
    expect(analyzeOffer(offer).errors["optimistic.equity"]).toBeTruthy();
    offer.rates.optimistic.equity = "100";
    offer.rates.neutral.bonus = "";
    expect(analyzeOffer(offer).errors["neutral.bonus"]).toBeTruthy();
    offer.rates.neutral.bonus = "50";
    offer.values.weeklyHours = "168";
    expect(analyzeOffer(offer).errors.commuteMinutes).toBeTruthy();
  });

  it("零现金、负收益与远程工作仍得出有限、真实的结果", () => {
    const [offer] = createExampleOffers();
    offer.values.monthlySalary = "0";
    offer.values.annualAllowance = "0";
    offer.values.annualBonus = "0";
    offer.values.annualEquity = "0";
    offer.values.onsiteDays = "0";
    const result = analyzeOffer(offer).scenarios!.neutral;
    expect(result.cashAfterCosts).toBe(-24000);
    expect(result.annualCommuteHours).toBe(0);
    expect(result.effectiveHourlyCash).toBe(-10);
  });
});

describe("个人偏好与 HR 清单", () => {
  it("按非零权重归一化，待评估和全零权重不伪造分数", () => {
    const [offer] = createExampleOffers();
    const weights = { growth: 5, stability: 0, culture: 0, flexibility: 5 };
    expect(preferenceScore(offer, weights)).toBe(70);
    expect(preferenceScore(offer, { ...weights, flexibility: 0 })).toBe(100);
    offer.ratings.stability = null;
    expect(preferenceScore(offer, weights)).toBe(70);
    offer.ratings.growth = null;
    expect(preferenceScore(offer, weights)).toBeNull();
    expect(preferenceScore(offer, { growth: 0, stability: 0, culture: 0, flexibility: 0 })).toBeNull();
    expect(preferenceScore(offer, { ...weights, growth: NaN })).toBeNull();
  });

  it("按未知项和真实收入项目生成问题，已核实项从对应清单移除", () => {
    const [a, b] = createExampleOffers();
    expect(hrQuestions(a).join("\n")).toContain("权益的授予数量");
    expect(hrQuestions(b).join("\n")).not.toContain("权益的授予数量");
    expect(hrQuestions(a).join("\n")).toContain("关于地点与工作灵活性");
    a.confirmed.compensation = true;
    a.confirmed.bonus = true;
    expect(hrQuestions(a).join("\n")).not.toContain("保证发薪月数");
    expect(hrQuestions(a).join("\n")).not.toContain("年度目标奖金");
    expect(hrQuestions(b).join("\n")).toContain("年度目标奖金");
    expect(hrQuestions(createOfferDraft()).join("\n")).toContain("年度目标奖金");
  });
});
