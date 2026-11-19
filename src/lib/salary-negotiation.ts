/** Offer 谈判与薪酬博弈模拟器的领域类型与清洗规整 */
import { hasQuestionContent } from "./question-normalization";

export type CompanyTier = "top_tech" | "unicorn" | "mid_stable" | "startup" | "custom";

export type HrStyle = "pressure" | "standard" | "emotional";

export type PersuasionGrade = "A" | "B" | "C" | "D";

export type HrMindset = {
  /** 模拟可谈程度 0-100，仅为练习状态，不是真实心理或成功概率 */
  looseness: number;
  /** 当前博弈态势标签 (如: 强硬施压 / 试探底线 / 出现动摇 / 实质让步 / 达成共识) */
  current_attitude: string;
  /** 模拟可谈方案，非真实公司上限或已经承诺的报价 */
  estimated_package: string;
  /** HR 出招类型简评 (如: 薪级带宽上限压制 / 拆分期权画饼 / 借大环境施压) */
  tactics_label: string;
  /** 模拟情境的内部约束，未知时应说明未设定 */
  internal_pressure: string;
};

export type SuggestedReply = {
  /** 话术策略标签 (如: 价值锚定反击 / 委婉探底置换签字费 / 竞品 Offer 施压) */
  title: string;
  /** 推荐的具体回复范例 */
  content: string;
  /** 建议的依据与作用，不是已验证的心理学结论 */
  rationale: string;
};

export type MentorAnalysis = {
  /** 本回合候选人发言评分 1-10；未发言的开局固定 5，仅为占位，不展示为评分 */
  user_argument_score: number;
  /** 展现出的优势筹码 (1-3 点) */
  strengths: string[];
  /** 暴露的逻辑漏洞或谈判破绽 (1-2 点) */
  vulnerabilities: string[];
  /** 军师实时点拨 (核心破局建议) */
  tactical_tips: string;
  /** 1-2 条推荐反击话术示范 */
  suggested_replies: SuggestedReply[];
};

export type NegotiationTurnData = {
  id: number;
  negotiation_id: number;
  turn_no: number;
  user_message: string;
  hr_response: string;
  hr_tactics: string;
  hr_mindset: HrMindset;
  mentor_analysis: MentorAnalysis;
  created_at: string;
};

export type TurnCritique = {
  turn_no: number;
  gain_or_loss: "gain" | "loss" | "neutral";
  summary: string;
  key_point: string;
};

export type NegotiationReport = {
  /** 本次模拟结果，须保留尚未达成、审批和未确认条件 */
  final_package_summary: string;
  /** 综合说服力评级 A/B/C/D */
  persuasion_grade: PersuasionGrade;
  /** 综合谈判得分 0-100 */
  score: number;
  /** 筹码转化效率深度剖析 */
  leverage_efficiency: string;
  /** 关键回合得失清单 */
  turn_critiques: TurnCritique[];
  /** 现实谈薪行动建议（生成时 1-4 条，硬上限见 NEGOTIATION_OUTPUT_LIMITS） */
  real_world_tips: string[];
  /** 军师寄语总结 */
  mentor_summary: string;
};

export type SalaryNegotiationDetail = {
  id: number;
  target_company_tier: string;
  target_role: string;
  expected_salary: string;
  current_or_competing_offer: string;
  hr_style: HrStyle;
  status: "ongoing" | "finished";
  initial_offer: string;
  final_package: string;
  report: NegotiationReport | null;
  created_at: string;
  finished_at: string;
  turns: NegotiationTurnData[];
};

export const COMPANY_TIER_OPTIONS: { key: CompanyTier; label: string; desc: string }[] = [
  { key: "top_tech", label: "头部大厂", desc: "练习核实职级、薪酬结构与审批流程，不预设带宽或签字费空间" },
  { key: "unicorn", label: "外企独角兽", desc: "练习比较固定现金、浮动奖金与股权条款，不预设股权价值" },
  { key: "mid_stable", label: "中型稳健企业", desc: "练习澄清保证薪数、绩效条件与岗位职责，不预设奖金占比" },
  { key: "startup", label: "初创团队", desc: "练习核实现金保障、股权兑现条件与岗位风险，不预设现金紧张或未来收益" },
  { key: "custom", label: "自定义企业", desc: "根据明确提供的岗位与条件练习，未提供的信息保持待确认" },
];

export const HR_STYLE_OPTIONS: { key: HrStyle; label: string; persona: string; practiceFocus: string }[] = [
  {
    key: "pressure",
    label: "施压挑刺型",
    persona: "模拟 HR 以追问依据、质疑诉求和强调已知约束施压，不凭空设定候选人短板或行业形势",
    practiceFocus: "用已提供的事实回应质疑，澄清可协商条件并表达边界；没有竞品 Offer 时不虚构筹码",
  },
  {
    key: "standard",
    label: "职业规范型",
    persona: "模拟 HR 按流程讨论薪酬组成、定级依据和审批条件，未提供的政策或权限保持待确认",
    practiceFocus: "逐项核实保证收入、浮动条件与审批人；询问替代方案是否存在，不假定对方有权让步",
  },
  {
    key: "emotional",
    label: "情感画饼型",
    persona: "模拟 HR 侧重团队认同与成长愿景，未被证实的前景仅作为设想，不承诺收益或晋升",
    practiceFocus: "把愿景与当前待遇分开，追问可验证的兑现条件；不假定招聘紧迫或情感认同会换来加薪",
  },
];

/** 三阶段模型输入与评测共用页面预设；自定义或旧描述保持原文。 */
export function describeNegotiationCompany(value: string): string {
  const option = COMPANY_TIER_OPTIONS.find((item) => item.key === value);
  return option ? `${option.label}（${option.desc}）` : value;
}

export function describeNegotiationHrStyle(option: (typeof HR_STYLE_OPTIONS)[number]): string {
  return `${option.label}：${option.persona}。练习重点：${option.practiceFocus}`;
}

/** 生成路径的兼容规整；历史详情改用 salary-negotiation-history 的无损读取。 */
export function normalizeHrMindset(raw: unknown): HrMindset {
  if (!raw || typeof raw !== "object") {
    return {
      looseness: 15,
      current_attitude: "严守初次开价",
      estimated_package: "按初始方案坚守",
      tactics_label: "常规出招",
      internal_pressure: "正常推进招聘",
    };
  }
  const o = raw as Record<string, unknown>;
  const loosenessNum = Number(o.looseness);
  const looseness = Number.isFinite(loosenessNum) ? Math.min(100, Math.max(0, Math.round(loosenessNum))) : 15;
  return {
    looseness,
    current_attitude: typeof o.current_attitude === "string" && o.current_attitude.trim() ? o.current_attitude.trim().slice(0, 30) : "审视试探",
    estimated_package: typeof o.estimated_package === "string" && o.estimated_package.trim() ? o.estimated_package.trim().slice(0, 50) : "按初始方案坚守",
    tactics_label: typeof o.tactics_label === "string" && o.tactics_label.trim() ? o.tactics_label.trim().slice(0, 40) : "常规沟通",
    internal_pressure: typeof o.internal_pressure === "string" && o.internal_pressure.trim() ? o.internal_pressure.trim().slice(0, 60) : "按流程评估",
  };
}

export function normalizeMentorAnalysis(raw: unknown): MentorAnalysis {
  const fallbackReplies: SuggestedReply[] = [
    {
      title: "价值重申与温和探底",
      content: "非常感谢您的认可。考虑到这个岗位面临的业务复杂度和我的即战力，这个方案与我预期仍有差距，不知在 base 或签字费上是否还有商议空间？",
      rationale: "肯定认可的同时坚定表达差距，将压力反抛给 HR，促使其展示弹性空间。",
    },
  ];

  if (!raw || typeof raw !== "object") {
    return {
      user_argument_score: 6,
      strengths: ["保持了礼貌沟通态度"],
      vulnerabilities: ["尚未形成有力的价格锚点"],
      tactical_tips: "明确你的核心诉求，不要过早妥协。",
      suggested_replies: fallbackReplies,
    };
  }
  const o = raw as Record<string, unknown>;
  const scoreNum = Number(o.user_argument_score);
  const score = Number.isFinite(scoreNum) ? Math.min(10, Math.max(1, Math.round(scoreNum))) : 6;

  const strengths = Array.isArray(o.strengths)
    ? o.strengths.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim().slice(0, 80)).slice(0, 4)
    : ["表达清晰"];

  const vulnerabilities = Array.isArray(o.vulnerabilities)
    ? o.vulnerabilities.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim().slice(0, 80)).slice(0, 4)
    : ["筹码施展力度不足"];

  const tactical_tips = typeof o.tactical_tips === "string" && o.tactical_tips.trim()
    ? o.tactical_tips.trim().slice(0, 200)
    : "聚焦自身核心增量价值，适度借力外部竞品行情。";

  const replies: SuggestedReply[] = [];
  if (Array.isArray(o.suggested_replies)) {
    for (const r of o.suggested_replies.slice(0, 2)) {
      if (r && typeof r === "object") {
        const ro = r as Record<string, unknown>;
        const title = typeof ro.title === "string" && ro.title.trim() ? ro.title.trim().slice(0, 30) : "战术应对";
        const content = typeof ro.content === "string" && ro.content.trim() ? ro.content.trim().slice(0, 300) : "";
        const rationale = typeof ro.rationale === "string" && ro.rationale.trim() ? ro.rationale.trim().slice(0, 150) : "";
        if (content) replies.push({ title, content, rationale });
      }
    }
  }

  return {
    user_argument_score: score,
    strengths: strengths.length ? strengths : ["态度稳健"],
    vulnerabilities: vulnerabilities.length ? vulnerabilities : ["底牌展露略快"],
    tactical_tips,
    suggested_replies: replies.length ? replies : fallbackReplies,
  };
}

export function normalizeNegotiationReport(raw: unknown): NegotiationReport | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const final_package_summary = typeof o.final_package_summary === "string" ? o.final_package_summary.trim() : "";
  const rawGrade = String(o.persuasion_grade || "B").toUpperCase();
  const persuasion_grade: PersuasionGrade = ["A", "B", "C", "D"].includes(rawGrade) ? (rawGrade as PersuasionGrade) : "B";
  const scoreNum = Number(o.score);
  const score = Number.isFinite(scoreNum) ? Math.min(100, Math.max(0, Math.round(scoreNum))) : 75;
  const leverage_efficiency = typeof o.leverage_efficiency === "string" ? o.leverage_efficiency.trim() : "";

  const turn_critiques: TurnCritique[] = [];
  if (Array.isArray(o.turn_critiques)) {
    for (const item of o.turn_critiques) {
      if (item && typeof item === "object") {
        const c = item as Record<string, unknown>;
        const turn_no = Number(c.turn_no) || 1;
        const gol = String(c.gain_or_loss);
        const gain_or_loss: "gain" | "loss" | "neutral" = gol === "gain" || gol === "loss" ? gol : "neutral";
        turn_critiques.push({
          turn_no,
          gain_or_loss,
          summary: typeof c.summary === "string" ? c.summary.trim().slice(0, 100) : "",
          key_point: typeof c.key_point === "string" ? c.key_point.trim().slice(0, 150) : "",
        });
      }
    }
  }

  const real_world_tips = Array.isArray(o.real_world_tips)
    ? o.real_world_tips.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 150)).slice(0, 5)
    : [];

  const mentor_summary = typeof o.mentor_summary === "string" ? o.mentor_summary.trim() : "";

  if (!final_package_summary || !mentor_summary) return null;

  return {
    final_package_summary,
    persuasion_grade,
    score,
    leverage_efficiency: leverage_efficiency || "综合表现稳健，关键筹码基本发挥作用。",
    turn_critiques,
    real_world_tips: real_world_tips.length ? real_world_tips : ["谈薪前务必摸清同行业同职级带宽", "保持良好态度，对事不对人"],
    mentor_summary,
  };
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
/** 新生成内容的硬上限；先完整校验，再进入兼容清洗，避免截掉金额口径或句尾条件。 */
export const NEGOTIATION_OUTPUT_LIMITS = {
  initial_offer: 300, hr_response: 200, hr_tactics: 120,
  current_attitude: 30, estimated_package: 50, tactics_label: 40, internal_pressure: 60,
  strength: 80, vulnerability: 80, tactical_tips: 200,
  reply_title: 30, reply_content: 300, reply_rationale: 150,
  final_package_summary: 500, leverage_efficiency: 500, mentor_summary: 500,
  critique_summary: 100, critique_key_point: 150, real_world_tip: 150,
  max_observations: 3, max_replies: 2, max_real_world_tips: 4,
} as const;

function requiredText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && hasQuestionContent(value); }
function boundedText(value: unknown, max: number): value is string {
  return requiredText(value) && value.trim().length <= max;
}
function validMindset(value: unknown): boolean {
  if (!objectRecord(value) || !hasExactKeys(value, ["looseness", "current_attitude", "estimated_package", "tactics_label", "internal_pressure"]) || typeof value.looseness !== "number" || !Number.isInteger(value.looseness) || value.looseness < 0 || value.looseness > 100) return false;
  return (["current_attitude", "estimated_package", "tactics_label", "internal_pressure"] as const)
    .every((key) => boundedText(value[key], NEGOTIATION_OUTPUT_LIMITS[key]));
}
function validMentor(value: unknown): boolean {
  if (!objectRecord(value) || !hasExactKeys(value, ["user_argument_score", "strengths", "vulnerabilities", "tactical_tips", "suggested_replies"]) || typeof value.user_argument_score !== "number" || !Number.isInteger(value.user_argument_score) || value.user_argument_score < 1 || value.user_argument_score > 10) return false;
  const limits = NEGOTIATION_OUTPUT_LIMITS;
  if (!Array.isArray(value.strengths) || value.strengths.length === 0 || value.strengths.length > limits.max_observations || !value.strengths.every((item) => boundedText(item, limits.strength))) return false;
  if (!Array.isArray(value.vulnerabilities) || value.vulnerabilities.length === 0 || value.vulnerabilities.length > limits.max_observations || !value.vulnerabilities.every((item) => boundedText(item, limits.vulnerability)) || !boundedText(value.tactical_tips, limits.tactical_tips)) return false;
  return Array.isArray(value.suggested_replies) && value.suggested_replies.length > 0 && value.suggested_replies.length <= limits.max_replies && value.suggested_replies.every((reply) => objectRecord(reply) && hasExactKeys(reply, ["title", "content", "rationale"]) && boundedText(reply.title, limits.reply_title) && boundedText(reply.content, limits.reply_content) && boundedText(reply.rationale, limits.reply_rationale));
}

export function validateGeneratedNegotiationOpening(raw: unknown): { initial_offer: string; hr_response: string; hr_tactics: string; hr_mindset: HrMindset; mentor_analysis: MentorAnalysis } | null {
  const limits = NEGOTIATION_OUTPUT_LIMITS;
  if (!objectRecord(raw) || !hasExactKeys(raw, ["initial_offer", "hr_response", "hr_tactics", "mentor_analysis", "hr_mindset"]) || !boundedText(raw.initial_offer, limits.initial_offer) || !boundedText(raw.hr_response, limits.hr_response) || !boundedText(raw.hr_tactics, limits.hr_tactics) || !validMindset(raw.hr_mindset) || !objectRecord(raw.mentor_analysis) || raw.mentor_analysis.user_argument_score !== 5 || !validMentor(raw.mentor_analysis)) return null;
  return { initial_offer: raw.initial_offer.trim(), hr_response: raw.hr_response.trim(), hr_tactics: raw.hr_tactics.trim(), hr_mindset: normalizeHrMindset(raw.hr_mindset), mentor_analysis: { ...normalizeMentorAnalysis(raw.mentor_analysis), user_argument_score: 5 } };
}

export function validateGeneratedNegotiationTurn(raw: unknown): { hr_response: string; hr_tactics: string; hr_mindset: HrMindset; mentor_analysis: MentorAnalysis } | null {
  const limits = NEGOTIATION_OUTPUT_LIMITS;
  if (!objectRecord(raw) || !hasExactKeys(raw, ["hr_response", "hr_tactics", "hr_mindset", "mentor_analysis"]) || !boundedText(raw.hr_response, limits.hr_response) || !boundedText(raw.hr_tactics, limits.hr_tactics) || !validMindset(raw.hr_mindset) || !validMentor(raw.mentor_analysis)) return null;
  return { hr_response: raw.hr_response.trim(), hr_tactics: raw.hr_tactics.trim(), hr_mindset: normalizeHrMindset(raw.hr_mindset), mentor_analysis: normalizeMentorAnalysis(raw.mentor_analysis) };
}

/** 只校验新生成结果；历史报告由 salary-negotiation-history 无损读取。 */
export function validateGeneratedNegotiationReport(raw: unknown, candidateTurnNumbers: readonly number[]): NegotiationReport | null {
  const limits = NEGOTIATION_OUTPUT_LIMITS;
  if (!objectRecord(raw) || !hasExactKeys(raw, ["final_package_summary", "score", "leverage_efficiency", "turn_critiques", "real_world_tips", "mentor_summary"]) || !boundedText(raw.final_package_summary, limits.final_package_summary) || typeof raw.score !== "number" || !Number.isInteger(raw.score) || raw.score < 0 || raw.score > 100 || !boundedText(raw.leverage_efficiency, limits.leverage_efficiency) || !Array.isArray(raw.turn_critiques) || !Array.isArray(raw.real_world_tips) || raw.real_world_tips.length === 0 || raw.real_world_tips.length > limits.max_real_world_tips || !raw.real_world_tips.every((item) => boundedText(item, limits.real_world_tip)) || !boundedText(raw.mentor_summary, limits.mentor_summary)) return null;
  const allowedTurns = new Set(candidateTurnNumbers);
  const seenTurns = new Set<number>();
  for (const item of raw.turn_critiques) {
    if (!objectRecord(item) || !hasExactKeys(item, ["turn_no", "gain_or_loss", "summary", "key_point"]) || typeof item.turn_no !== "number" || !Number.isSafeInteger(item.turn_no) || item.turn_no <= 0 || !allowedTurns.has(item.turn_no) || seenTurns.has(item.turn_no) || !["gain", "loss", "neutral"].includes(item.gain_or_loss as string) || !boundedText(item.summary, limits.critique_summary) || !boundedText(item.key_point, limits.critique_key_point)) return null;
    seenTurns.add(item.turn_no);
  }
  // 等级是分数的确定性派生值，忽略旧版模型可能返回的矛盾等级。
  const persuasion_grade: PersuasionGrade = raw.score >= 85 ? "A" : raw.score >= 70 ? "B" : raw.score >= 50 ? "C" : "D";
  return normalizeNegotiationReport({ ...raw, persuasion_grade });
}
