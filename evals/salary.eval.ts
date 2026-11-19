import { it } from "vitest";
import {
  SALARY_NEGOTIATION_FINALIZE_PROMPT,
  SALARY_NEGOTIATION_OPENING_PROMPT,
  SALARY_NEGOTIATION_TURN_PROMPT,
  buildFinalizeMessages,
  buildOpeningMessages,
  buildTurnHistoryMessages,
} from "@/lib/salary-negotiation-llm";
import {
  HR_STYLE_OPTIONS,
  describeNegotiationCompany,
  describeNegotiationHrStyle,
  type CompanyTier,
  type HrStyle,
  validateGeneratedNegotiationOpening,
  validateGeneratedNegotiationReport,
  validateGeneratedNegotiationTurn,
} from "@/lib/salary-negotiation";
import { LLM_FEATURES, safeChat } from "@/lib/safe-llm";
import { createEvaluationSuite } from "./harness";

function preset(companyTier: CompanyTier, hrStyle: HrStyle) {
  return {
    companyTier,
    hrStyle,
    targetCompanyTier: describeNegotiationCompany(companyTier),
    hrStyleDesc: describeNegotiationHrStyle(HR_STYLE_OPTIONS.find(option => option.key === hrStyle)!),
  };
}

const background = {
  ...preset("mid_stable", "standard"),
  targetRole: "后端工程师",
  expectedSalary: "期望税前月薪 34k-38k，薪数待确认",
  currentOrCompetingOffer: "",
};
const initialOffer = "模拟税前月薪 31k，保证薪数与奖金待确认。";

const opening = {
  id: "opening-no-competing-offer",
  rubric: [
    "开局 user_argument_score 必须固定为 5，明确候选人尚未发言，不臆造谈判表现。",
    "所有开价、HR 心理与可谈空间均标为模拟；未提供竞品 Offer 时不得虚构筹码或真实公司预算。",
    "先澄清月薪税前税后、保证薪数与奖金条件，不把口径不明的项目合并为保证年收入。",
    "施压风格不能凭空增加候选人短板、竞品 Offer 或行业下行事实；头部大厂预设不能证明签字费空间或 HR 的审批权。",
  ],
};

const turn = {
  id: "turn-inquiry-is-not-acceptance",
  turns: [{ turn_no: 1, user_message: "谢谢说明。请问 31k 是税前月薪吗，保证薪数和奖金条件能否确认后我再评估？", hr_response: "模拟 HR 初始提出税前月薪 31k，保证薪数和奖金待确认。", hr_mindset: "模拟状态：中性，尚未确认薪数。" }],
  newUserMessage: "请问保证薪数是多少？",
  rubric: [
    "将询价视为澄清，不判定候选人已接受、拒绝、设定底线或承诺入职。",
    "沿用 31k 税前月薪的模拟历史报价；保证薪数未知时继续标为待确认，不自行补全。",
    "只根据本轮发言评分，不把此前询价或建议回复当成新提出的筹码。",
  ],
};

const finalize = {
  id: "finalize-one-sided-acceptance",
  turns: [{
    turn_no: 1,
    user_message: "如果能给 36k，我可以接受。",
    hr_response: "模拟 HR 表示需与招聘团队确认薪数与奖金，之后再书面回复。",
    hr_mindset_str: "模拟状态：薪数与奖金待确认。",
    mentor_analysis_str: "候选人提出了附条件意愿，尚未确认完整方案。",
  }],
  finalWords: "我愿意按 36k 继续沟通。",
  agreedPackage: "我接受 36k。",
  rubric: [
    "报告必须说明尚未达成双方一致：候选人的单方接受或补记不能证明 HR 已同意。",
    "保留 HR 尚待确认薪数、奖金并书面回复的条件，不把 36k 写成最终锁定 Offer。",
    "回合点评仅引用含候选人发言的实际 turn_no 1，不将结束补记作为新对话回合。",
  ],
};

const presetTurns = [
  {
    id: "standard-preset-has-no-approval-authority",
    ...preset("top_tech", "standard"),
    initialOffer: "模拟税前月薪 31k，保证 12 薪；本岗位无签字费和股权，调整月薪须另行审批。",
    turns: [{
      turn_no: 1,
      user_message: "我没有竞品 Offer，想确认是否可以申请调整月薪。",
      hr_response: "本次模拟岗位无签字费和股权。月薪调整须另行审批，我只能提交申请，不能承诺结果。",
      hr_mindset: "模拟约束：无签字费和股权，仅能提交月薪调整申请，审批结果未知。",
    }],
    newUserMessage: "请问申请调整月薪需要补充哪些岗位相关依据？",
    rubric: [
      "保留无签字费、无股权及 HR 仅能提交申请的明确条件；不按公司类型或职业规范型预设恢复这些选项或授予 HR 审批权。",
      "询问所需依据不等于已经提交业绩，也不等于申请已经获批；不凭轮次或配合态度自动加价。",
      "建议围绕核实审批要求和提供真实岗位依据，不虚构竞品 Offer 或已证明的业绩。",
    ],
  },
  {
    id: "emotional-preset-keeps-cash-and-unknown-deadline",
    ...preset("startup", "emotional"),
    initialOffer: "模拟税前月薪 31k，保证 12 薪；无股权方案，尚未约定到岗日期。",
    turns: [{
      turn_no: 1,
      user_message: "我重视团队成长，也希望确认当前现金待遇。",
      hr_response: "本次模拟保证 12 薪，目前没有股权方案。团队发展是愿景，尚未约定到岗日期。",
      hr_mindset: "模拟约束：保证 12 薪，无股权；到岗时限与招聘压力未设定。",
    }],
    newUserMessage: "谢谢介绍。我想先核实保证现金和书面条件，再评估是否接受。",
    rubric: [
      "保留已明确的保证 12 薪和无股权条件，不因初创企业预设改写为现金紧张、股权替代工资或必然升值。",
      "不因情感画饼型预设补造到岗期限、招聘紧迫或快速妥协；愿景不能计入保证收入或已承诺晋升。",
      "候选人尚未接受，也未承诺到岗；评分按澄清条件的实际表达，不因没有情感附和或竞品 Offer 扣分。",
    ],
  },
];

const extraFinalizations = [
  {
    id: "finalize-alternative-packages-stay-separate",
    initialOffer: "模拟方案 A：税前月薪 30k，保证 14 薪；无额外保证现金。",
    turns: [
      { turn_no: 1, user_message: "", hr_response: "模拟 HR 提出方案 A：税前月薪 30k，保证 14 薪。" },
      { turn_no: 2, user_message: "如果提高月薪，会如何影响保证薪数？", hr_response: "模拟替代方案 B：税前月薪 32k，保证 12 薪；与 A 二选一，不能组合，B 仍需审批。" },
      { turn_no: 4, user_message: "32k 的月薪方向可以，仍要确认薪数与审批，确认后再决定；我还没有接受整套方案，也没有承诺到岗。", hr_response: "模拟 HR 确认 B 的保证薪数为 12，但审批尚未完成。A 仍为 30k、14 薪；没有提出 32k、14 薪的组合。" },
    ],
    finalWords: "愿意继续比较两套方案，审批与书面条件确认后再决定。",
    agreedPackage: "倾向 B 的月薪，但未接受整套方案，审批和书面确认仍待完成。",
    rubric: [
      "A 与 B 分开保留，不拼接成 32k×14；如按相同币种计算保证年现金，A 为 420k、B 为 384k，均保留税前及 B 待审批条件，币种未明确时仍待确认，不把更高月薪直接当成更高保证年收入。",
      "候选人只认可月薪方向并愿意继续讨论，未接受整套方案、未承诺到岗；结束说明和所谓 agreedPackage 只是候选人补记，不能证明双方已达成。",
      "回合 1 仅 HR 开场，可点评的候选人回合只有原编号 2、4，不引用 1 或补造 3，也不把补记改成新回合。",
    ],
  },
  {
    id: "finalize-new-hr-condition-has-no-candidate-response",
    initialOffer: "模拟税前月薪 31k，保证薪数与试用期条件待确认。",
    turns: [
      { turn_no: 1, user_message: "", hr_response: "模拟 HR 初步说明税前月薪 31k，薪数和其他条件未定。" },
      { turn_no: 2, user_message: "请先说明保证薪数。", hr_response: "模拟 HR 说明保证 12 薪，仍需核实书面条款。" },
      { turn_no: 4, user_message: "谢谢，请确认其他保证现金条件后，我再一起评估。", hr_response: "模拟 HR 首次提出试用期工资八折，全部方案仍需审批；此前未说明这一条件。" },
    ],
    finalWords: "对方最后才补充试用期条件，我尚未在对话中回应。",
    agreedPackage: "尚未达成，试用期工资八折与审批条件需进一步确认。",
    rubric: [
      "按每回合候选人先说、HR 后答的顺序复盘；第 4 回合候选人发言时还不知道试用期八折，不因尚未回应新条件扣分，也不声称已经接受、忽略或拒绝该条件。",
      "可以在下一步建议核实试用期与审批，但不能把结束说明倒算为已在第 4 回合提出的异议，不能将 HR 新条件自动归因为候选人澄清提问的必然效果。",
      "完整方案未获双方确认，保留试用期八折与审批限制；点评只引用有候选人发言的 2、4，不引用仅开场的 1 或不存在的 3。",
    ],
  },
];

const firstYearCashSamples = [
  {
    id: "finalize-first-year-known-probation",
    salaryStages: "入职后的前 3 个月固定工资按 80% 支付，随后 9 个月全额支付。",
    calculationCriterion: "按入职首 12 个月的已知阶段计算：固定工资为人民币税前 342k，加首月一次性保证签字费 20k，首期保证现金为 362k；后续完整 12 个月固定工资为 360k。保留前 3 个月八折及后 9 个月全薪，不能只用 30k×12 代替首期分阶段工资，也不能省略已有足够条件的比较。",
  },
  {
    id: "finalize-first-year-unknown-probation",
    salaryStages: "试用期全部位于入职首 12 个月内，固定工资按 80% 支付，结束后全额支付；试用期时长尚未确定。",
    calculationCriterion: "试用期时长未知，首 12 个月保证现金无法确定；可用 n 表示首期八折月数，条件式为人民币税前 380k−6k×n（含一次性 20k），但不能默认 n=3 或全年全薪。后续完整 12 个月固定工资 360k 已可确定，不能把全部期间都说成未知。",
  },
  {
    id: "finalize-first-year-full-salary",
    salaryStages: "入职首 12 个月固定工资全部全额支付，没有试用期工资折减。",
    calculationCriterion: "全年全薪时，入职首 12 个月固定工资为人民币税前 360k，加首月一次性保证签字费 20k，首期保证现金为 380k；后续完整 12 个月固定工资仍为 360k。不能补造试用期折减，也不能因泛化不确定性拒绝已有足够条件的比较。",
  },
].map(({ id, salaryStages, calculationCriterion }) => {
  const offer = `模拟方案：人民币税前固定月薪 30k，保证 12 薪，无额外保证薪数。${salaryStages}入职首 12 个月之后，每个完整 12 个月均保持固定月薪 30k、保证 12 薪，全额支付，无新增工资折减。保证一次性签字费 20k，入职首月支付，无返还条件，以后不重复。绩效奖金为 0–50k，不保证；无其他保证现金。以上均为本次提出的模拟条款，候选人尚未接受。`;
  return {
    id,
    expectedSalary: "希望比较入职首 12 个月与之后完整 12 个月的保证现金，尚未决定是否接受。",
    initialOffer: "模拟初步沟通，尚未列明金额、工资阶段、一次性现金和浮动部分。",
    turns: [{
      turn_no: 1,
      user_message: "请列明工资在各阶段的支付方式、一次性现金及浮动部分，我再评估。",
      hr_response: offer,
    }],
    finalWords: "我还没接受，想比较入职首 12 个月与之后完整 12 个月的保证现金，再决定。",
    agreedPackage: "尚未达成，只有 HR 提出的模拟条款，没有候选人接受记录。",
    rubric: [
      calculationCriterion,
      "一次性签字费 20k 仅计入入职首期，保留首月支付且无返还条件，不当作每年重复收入；绩效 0–50k 不保证，不能并入保证现金，任何总额保持人民币税前口径。",
      "全部金额是模拟方案的条款，候选人尚未接受；不把比较或结束补记写成双方达成，也不添加未给的审批、支付或返还前提。",
      "只点评含候选人发言的原回合 1，保留候选人先问、HR 后答的顺序，不因未回应随后才给的金额或阶段条件扣分，也不把结束补记变成新增回合。",
    ],
  };
});

// 独立新增对照：旧三例保留历史身份，签字费的税务范围在此逐项明示。
const explicitTaxScopeSamples = [
  {
    id: "finalize-explicit-gross-known-probation",
    salaryStages: "入职后的前 3 个月固定工资按 80% 支付，随后 9 个月全额支付。",
    signingTax: "签字费金额明确为税前。",
    calculationCriterion: "按已知阶段给出入职首12个月人民币税前固定工资342k，另加明确税前的一次性保证签字费20k，首期人民币税前保证现金为362k；后续每个完整12个月的固定工资为人民币税前360k。保留前3个月80%及后9个月全薪，不能用30k×12代替首期分阶段工资，也不能将已明确的签字费税前口径说成未知或省略已有足够条件的比较。",
  },
  {
    id: "finalize-explicit-gross-unknown-probation",
    salaryStages: "试用期全部位于入职首 12 个月内，固定工资按 80% 支付，结束后全额支付；试用期时长尚未确定。",
    signingTax: "签字费金额明确为税前。",
    calculationCriterion: "试用期时长未知，首12个月的确定保证现金无法计算；可用n表示首期八折月数，给出人民币税前380k−6k×n或等价条件式，但不能默认n=3、全年全薪或确定的首期总额。保留试用期全部在首12个月内、80%后全薪及签字费20k明确税前；后续每个完整12个月的人民币税前固定工资360k已确定，不能把所有期间都说成未知，也不能无条件断言首期比后续更高或更低。",
  },
  {
    id: "finalize-explicit-gross-full-salary",
    salaryStages: "入职首 12 个月固定工资全部全额支付，没有试用期工资折减。",
    signingTax: "签字费金额明确为税前。",
    calculationCriterion: "首12个月无试用期工资折减，人民币税前固定工资360k，加明确税前的一次性保证签字费20k，首期人民币税前保证现金为380k；后续每个完整12个月固定工资仍为人民币税前360k。不能补造工资折减，不能把签字费税务口径降为未知，也不能因泛化不确定性拒绝已有足够条件的比较。",
  },
  {
    id: "finalize-signing-tax-unspecified",
    salaryStages: "入职后的前 3 个月固定工资按 80% 支付，随后 9 个月全额支付。",
    signingTax: "签字费金额的税前或税后口径尚未说明，折算所需税额未知。",
    calculationCriterion: "保留前3个月80%、后9个月全薪，算出首12个月固定工资为人民币税前342k，后续每个完整12个月固定工资为人民币税前360k；一次性签字费20k的税前或税后口径未说明，因此首期统一税务口径的保证现金总额尚不能确定。允许将签字费20k与工资分列，或明确假设签字费为税前后给出条件362k；不得将362k写成已确定税前、税后或实际到账合计，不得默认签字费口径或抹去已知342k与360k。",
  },
  {
    id: "finalize-signing-tax-net",
    salaryStages: "入职后的前 3 个月固定工资按 80% 支付，随后 9 个月全额支付。",
    signingTax: "签字费金额明确为税后到手，对应税前金额未提供，折算所需税额未知。",
    calculationCriterion: "保留前3个月80%、后9个月全薪，算出首12个月固定工资为人民币税前342k，后续每个完整12个月固定工资为人民币税前360k；保证签字费20k已明确为人民币税后到手，不能将其降为税前税后未知或改写为税前20k。将342k税前工资与20k税后签字费分列；签字费税前等值及工资税后值未给时，不能直接相加为已确定的税前或税后362k总额，不补造税率、毛化结果或其他税款承担安排。首期统一税务口径合计未确定，不影响已知固定工资及后续360k。",
  },
].map(({ id, salaryStages, signingTax, calculationCriterion }) => ({
  id,
  expectedSalary: "希望比较入职首 12 个月与之后完整 12 个月的保证现金，尚未决定是否接受。",
  initialOffer: "模拟初步沟通，尚未列明金额、工资阶段、一次性现金和浮动部分。",
  turns: [{
    turn_no: 1,
    user_message: "请列明工资在各阶段的支付方式、一次性现金及浮动部分，我再评估。",
    hr_response: `模拟方案：本方案所有金额均为人民币；固定工资及绩效奖金口径均为税前。固定月薪 30k，保证 12 薪，无额外保证薪数。${salaryStages}入职首 12 个月之后，每个完整 12 个月均保持税前固定月薪 30k、保证 12 薪，全额支付，无新增工资折减。保证一次性签字费 20k，入职首月支付，无返还条件，以后不重复。${signingTax}绩效奖金为税前 0–50k，不保证；无其他保证现金。以上均为本次提出的模拟条款，候选人尚未接受。`,
  }],
  finalWords: "我还没接受，想比较入职首 12 个月与之后完整 12 个月的保证现金，再决定。",
  agreedPackage: "尚未达成，只有 HR 提出的模拟条款，没有候选人接受记录。",
  rubric: [
    calculationCriterion,
    "一次性签字费20k为保证现金，只适用于入职首期；保留首月支付、无返还条件、以后不重复，不当作后续每年收入。绩效奖金为人民币税前0–50k且不保证，必须与保证现金分列。保留全部金额的人民币币种及每项已给税务口径；某项税务口径未知不使已知固定工资也变成未知，不将不同税务口径直接相加为同口径总额。",
    "全部金额是HR提出的模拟条款，候选人尚未接受；不把比较、结束说明或agreedPackage补记写成双方已达成，也不添加未给的审批、支付或返还前提。可以建议取得书面条款，但不能据此把原材料已经明确的条款改写为未提供或待审批。",
    "只点评含候选人发言的原回合1，保留候选人先询问、HR随后才给出金额、阶段及签字费税务条件的顺序。任何复盘字段均不能因候选人未回应随后才给出的条件而列为失误或扣分；核实未知项可作为下一步建议，不把结束补记改成当轮已提出异议或新增回合。",
  ],
}));

const finalizationSamples = [finalize, ...extraFinalizations, ...firstYearCashSamples, ...explicitTaxScopeSamples].map(sample => ({
  ...sample,
  // 生产类型保留的旧点评字段不会进入收尾消息；评测不补造这些内容。
  turns: sample.turns.map(turn => ({ hr_mindset_str: "", mentor_analysis_str: "", ...turn })),
}));
const evaluate = createEvaluationSuite("salary", 2 + presetTurns.length + finalizationSamples.length, 2200);

it(opening.id, async () => {
  const system = SALARY_NEGOTIATION_OPENING_PROMPT;
  const input = { ...background, ...preset("top_tech", "pressure") };
  const messages = buildOpeningMessages(input);
  await evaluate({
    id: opening.id,
    input,
    system,
    messages,
    rubric: opening.rubric,
    call: opts => safeChat("evaluate", { feature: LLM_FEATURES.negotiationStart }, system, messages, opts),
    validate: value => validateGeneratedNegotiationOpening(value),
  });
});

it(turn.id, async () => {
  const system = SALARY_NEGOTIATION_TURN_PROMPT;
  const input = { ...background, initialOffer, ...turn };
  const messages = buildTurnHistoryMessages(input);
  await evaluate({
    id: turn.id,
    input,
    system,
    messages,
    rubric: turn.rubric,
    call: opts => safeChat("evaluate", { feature: LLM_FEATURES.negotiationTurn }, system, messages, opts),
    validate: value => validateGeneratedNegotiationTurn(value),
  });
});

for (const sample of presetTurns) {
  it(sample.id, async () => {
    const system = SALARY_NEGOTIATION_TURN_PROMPT;
    const input = { ...background, ...sample };
    const messages = buildTurnHistoryMessages(input);
    await evaluate({
      id: sample.id,
      input,
      system,
      messages,
      rubric: sample.rubric,
      call: opts => safeChat("evaluate", { feature: LLM_FEATURES.negotiationTurn }, system, messages, opts),
      validate: value => validateGeneratedNegotiationTurn(value),
    });
  });
}

for (const sample of finalizationSamples) {
  it(sample.id, async () => {
    const system = SALARY_NEGOTIATION_FINALIZE_PROMPT;
    const input = { ...background, initialOffer, ...sample };
    const messages = buildFinalizeMessages(input);
    await evaluate({
      id: sample.id,
      input,
      system,
      messages,
      rubric: sample.rubric,
      call: opts => safeChat("evaluate", { feature: LLM_FEATURES.negotiationFinalize }, system, messages, opts),
      validate: value => validateGeneratedNegotiationReport(value, input.turns.filter(turn => turn.user_message.trim()).map(turn => turn.turn_no)),
    });
  });
}
