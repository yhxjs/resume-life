/** Offer 谈判与薪酬博弈模拟器的领域类型与清洗规整 */

export type CompanyTier = "top_tech" | "unicorn" | "mid_stable" | "startup" | "custom";

export type HrStyle = "pressure" | "standard" | "emotional";

export type PersuasionGrade = "A" | "B" | "C" | "D";

export type HrMindset = {
  /** 底线松动度 0-100 (0=绝不让步, 100=完全松动已探底) */
  looseness: number;
  /** 当前博弈态势标签 (如: 强硬施压 / 试探底线 / 出现动摇 / 实质让步 / 达成共识) */
  current_attitude: string;
  /** HR 当前心理预估可给出的最高成交总包 */
  estimated_package: string;
  /** HR 出招类型简评 (如: 薪级带宽上限压制 / 拆分期权画饼 / 借大环境施压) */
  tactics_label: string;
  /** HR 内部现实压力 (如: 用人部门急催入职 / 备选池人选充足) */
  internal_pressure: string;
};

export type SuggestedReply = {
  /** 话术策略标签 (如: 价值锚定反击 / 委婉探底置换签字费 / 竞品 Offer 施压) */
  title: string;
  /** 推荐的具体回复范例 */
  content: string;
  /** 谈判心理学逻辑拆解 */
  rationale: string;
};

export type MentorAnalysis = {
  /** 求职者上轮回合说服逻辑评分 1-10 */
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
  /** 最终锁定总包 package 评估分析 */
  final_package_summary: string;
  /** 综合说服力评级 A/B/C/D */
  persuasion_grade: PersuasionGrade;
  /** 综合谈判得分 0-100 */
  score: number;
  /** 筹码转化效率深度剖析 */
  leverage_efficiency: string;
  /** 关键回合得失清单 */
  turn_critiques: TurnCritique[];
  /** 现实谈薪避坑锦囊 (3-5 条实战建议) */
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
  { key: "top_tech", label: "头部大厂", desc: "职级薪级带宽死板，重职级对标，base受限但签字费/期权空间大" },
  { key: "unicorn", label: "外企独角兽", desc: "重视文化契合与综合素质，现金base弹性适中，期权溢价想象力高" },
  { key: "mid_stable", label: "中型稳健企业", desc: "重现金流与即战力，考核严格，年终奖占比高，偏好保守稳健" },
  { key: "startup", label: "初创团队", desc: "现金流吃紧，极度依赖股权期权与未来期许拉齐预期，弹性大" },
  { key: "custom", label: "自定义企业", desc: "根据具体岗位与输入，动态调整博弈风格" },
];

export const HR_STYLE_OPTIONS: { key: HrStyle; label: string; persona: string; weakness: string }[] = [
  {
    key: "pressure",
    label: "施压挑刺型",
    persona: "紧抓过往经历短板与职级瓶颈，反复强调行业下行寒冬与 HC 竞争激烈，试图击穿心理底线压价",
    weakness: "害怕错失真正不可替代的硬核即战力，对竞品 Offer 与随时终止谈判的姿态敏感",
  },
  {
    key: "standard",
    label: "职业规范型",
    persona: "言必称公司薪酬带宽、职级公平与内部平衡，推崇标准化包并拿五险一金/补充福利做对冲",
    weakness: "受限于职级上限但拥有签字费、定级微调与绩效系数解释权，需用同级市场行情倒逼",
  },
  {
    key: "emotional",
    label: "情感画饼型",
    persona: "极力描绘业务爆发前景与核心团队站位，大打情感认同牌，用成长红利模糊眼前现金差额",
    weakness: "自身背负核心用人部门的到岗时限压力，对合情合理且不撕破脸的利益置换妥协快",
  },
];

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
function requiredText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validMindset(value: unknown): boolean {
  if (!objectRecord(value) || typeof value.looseness !== "number" || !Number.isFinite(value.looseness) || value.looseness < 0 || value.looseness > 100) return false;
  return ["current_attitude", "estimated_package", "tactics_label", "internal_pressure"].every((key) => requiredText(value[key]));
}
function validMentor(value: unknown): boolean {
  if (!objectRecord(value) || typeof value.user_argument_score !== "number" || !Number.isFinite(value.user_argument_score) || value.user_argument_score < 1 || value.user_argument_score > 10) return false;
  if (!Array.isArray(value.strengths) || value.strengths.length === 0 || !value.strengths.every(requiredText)) return false;
  if (!Array.isArray(value.vulnerabilities) || value.vulnerabilities.length === 0 || !value.vulnerabilities.every(requiredText) || !requiredText(value.tactical_tips)) return false;
  return Array.isArray(value.suggested_replies) && value.suggested_replies.length > 0 && value.suggested_replies.every((reply) => objectRecord(reply) && requiredText(reply.title) && requiredText(reply.content) && requiredText(reply.rationale));
}

export function validateGeneratedNegotiationOpening(raw: unknown): { initial_offer: string; hr_response: string; hr_tactics: string; hr_mindset: HrMindset; mentor_analysis: MentorAnalysis } | null {
  if (!objectRecord(raw) || !requiredText(raw.initial_offer) || !requiredText(raw.hr_response) || !requiredText(raw.hr_tactics) || !validMindset(raw.hr_mindset) || !validMentor(raw.mentor_analysis)) return null;
  return { initial_offer: raw.initial_offer.trim(), hr_response: raw.hr_response.trim(), hr_tactics: raw.hr_tactics.trim(), hr_mindset: normalizeHrMindset(raw.hr_mindset), mentor_analysis: normalizeMentorAnalysis(raw.mentor_analysis) };
}

export function validateGeneratedNegotiationTurn(raw: unknown): { hr_response: string; hr_tactics: string; hr_mindset: HrMindset; mentor_analysis: MentorAnalysis } | null {
  if (!objectRecord(raw) || !requiredText(raw.hr_response) || !requiredText(raw.hr_tactics) || !validMindset(raw.hr_mindset) || !validMentor(raw.mentor_analysis)) return null;
  return { hr_response: raw.hr_response.trim(), hr_tactics: raw.hr_tactics.trim(), hr_mindset: normalizeHrMindset(raw.hr_mindset), mentor_analysis: normalizeMentorAnalysis(raw.mentor_analysis) };
}

export function validateGeneratedNegotiationReport(raw: unknown): NegotiationReport | null {
  if (!objectRecord(raw) || !requiredText(raw.final_package_summary) || !["A", "B", "C", "D"].includes(raw.persuasion_grade as string) || typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > 100 || !requiredText(raw.leverage_efficiency) || !Array.isArray(raw.turn_critiques) || !Array.isArray(raw.real_world_tips) || raw.real_world_tips.length === 0 || !raw.real_world_tips.every(requiredText) || !requiredText(raw.mentor_summary)) return null;
  if (!raw.turn_critiques.every((item) => objectRecord(item) && typeof item.turn_no === "number" && Number.isSafeInteger(item.turn_no) && item.turn_no > 0 && ["gain", "loss", "neutral"].includes(item.gain_or_loss as string) && requiredText(item.summary) && requiredText(item.key_point))) return null;
  return normalizeNegotiationReport(raw);
}
