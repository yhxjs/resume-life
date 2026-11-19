/** 面试黑话与公司风格暗号解码器的领域类型、清洗规范与预置经典词库 */
import { hasQuestionContent, questionComparisonKey, textComparisonKey } from "./question-normalization";
import { resolveUntrustedSourceQuote } from "./prompt-safety";

export type DecodedItem = {
  /** 识别出的黑话/暗号关键词（如“抗压能力强”、“拥抱变化”） */
  keyword: string;
  /** 表面官方含义/说辞 */
  surfaceMeaning: string;
  /** 有依据的可能解释与待核实条件，不代表公司实际情况 */
  hiddenMeaning: string;
  /** 文本风险信号：low=弱, medium=待核实, high=强；null=未评估 */
  riskLevel: "low" | "medium" | "high" | null;
  /** 风险类型（如：加班过劳、业务动荡、资源匮乏、管理混乱、考核苛刻） */
  riskCategory: string;
  /** 踩坑警示（入职后可能真实面临的坑） */
  warning: string;
  /** 核实条件、表达真实诉求与边界的沟通建议 */
  interviewRule: string;
  /** 反向提问避坑指南（面试反问环节反客为主、探虚实的高情商提问） */
  counterQuestions: string[];
};

export type RiskRatings = {
  /** 加班过劳指数 1-10 */
  overtime: number | null;
  /** 业务动荡指数 1-10 */
  stability: number | null;
  /** 资源匮乏指数 1-10 */
  resources: number | null;
  /** 管理内耗指数 1-10 */
  management: number | null;
};

export type CompanyProfile = {
  /** 文本支持的公司/团队风格线索；不足时保留未知 */
  teamStyle: string;
  /** 潜在雷区/红线标签列表 */
  riskFlags: string[];
  /** 团队文化与日常工作节奏简评 */
  cultureSummary: string;
};

export type JargonDecoderResult = {
  /** 岗位/话术速写一句话 */
  targetSummary: string;
  /** 一句话概括最值得核实的问题 */
  punchline: string;
  /** 文本风险信号强度 1-100，不代表实际风险概率；null=未评估 */
  overallRiskScore: number | null;
  /** 4维度风险评分 */
  riskRatings: RiskRatings;
  /** 解析出的黑话潜台词列表 */
  items: DecodedItem[];
  /** 团队风格画像 */
  companyProfile: CompanyProfile;
  /** 有具体线索时提供优先核实问题；没有线索时为空 */
  goldenQuestions: string[];
};

/** 新生成报告的字段上限；历史数据仍使用兼容清洗规则。 */
export const JARGON_OUTPUT_LIMITS = {
  target_summary: 30, punchline: 50,
  surface_meaning: 200, hidden_meaning: 250, risk_category: 40, warning: 50, interview_rule: 300,
  counter_question: 150, team_style: 30, risk_flag: 30, max_risk_flags: 6, culture_summary: 100,
  golden_question: 160, min_golden_questions: 2, max_golden_questions: 3,
  max_items: 8, min_counter_questions: 1, max_counter_questions: 2,
} as const;

/** 通用释义与核实示例；没有具体公司材料，不能预先赋予风险等级。 */
export const PRESET_JARGONS: DecodedItem[] = [
  {
    keyword: "抗压能力强",
    surfaceMeaning: "希望候选人能在一定压力或紧急任务下推进工作。",
    hiddenMeaning: "可能强调处理紧急任务的能力，也可能涉及较高工作负荷；仅凭这一短语无法确认工时、排期或补偿安排。",
    riskLevel: null,
    riskCategory: "工作负荷与排期",
    warning: "若临时任务频繁且缺少排期与补偿，工作负荷可能超出预期。",
    interviewRule:
      "先核实紧急任务的频率、排期和补偿，再如实表达自己的可用时间与边界。若确有相关经历，可说明如何处理优先级或沟通风险；不必承诺无条件接受加班。",
    counterQuestions: [
      "请问团队通常在什么业务节点下会出现集中高强度攻坚？平时版本发布的标准周期大概是多久？",
      "如果上下游出现突发紧急变更，团队内部通常走怎样的优先级评估和排期协调流程？",
    ],
  },
  {
    keyword: "拥抱变化",
    surfaceMeaning: "希望候选人能适应业务、任务或工作方式的调整。",
    hiddenMeaning: "可能指正常迭代或探索新业务，也可能意味着方向与考核经常调整；需结合最近实例、决策依据与变更机制判断。",
    riskLevel: null,
    riskCategory: "方向调整与变更机制",
    warning: "若频繁转向却不调整资源和考核，既有投入与交付计划可能受影响。",
    interviewRule:
      "询问最近一次方向调整如何影响目标、排期与考核。若确有应对变更的经历，可说明实际行动和职责；没有对应经历时可讨论处理思路，不编造成已完成的架构成果。",
    counterQuestions: [
      "请问当前团队负责的核心业务线，今年最核心的 OKR 或战略优先级目标是什么？近期有经历过较大转向吗？",
      "当产品或运营方向产生突发调整时，团队通常如何平衡技术架构重构与业务快速交付？",
    ],
  },
  {
    keyword: "有从 0 到 1 经验",
    surfaceMeaning: "具备新业务、产品或体系从初始阶段建设的相关经历。",
    hiddenMeaning: "可能是在招募新产品或新体系的建设经验，并不直接说明资源匮乏。需核实已有基础、个人职责、团队支持和验收目标。",
    riskLevel: null,
    riskCategory: "建设范围与配套资源",
    warning: "若职责广泛但资源、权限与验收目标不清，交付预期可能不一致。",
    interviewRule:
      "先确认岗位负责哪一阶段、哪些模块以及可调用的资源。只说明真实参与范围；若没有独立从零建设的经历，可如实介绍相关部分或提出条件式思路，不认领团队全部成果。",
    counterQuestions: [
      "针对这个从 0 到 1 的方向，目前团队配置的专属资源（前后端、产品、预算等）已到位的有哪些？",
      "公司管理层对该新业务线的试错周期预期是多久？第一阶段验收的核心指标（里程碑）是什么？",
    ],
  },
  {
    keyword: "扁平化管理",
    surfaceMeaning: "希望表达管理层级较少、沟通链路较短。",
    hiddenMeaning: "可能表示层级较少、沟通直接，也可能存在职责和决策边界不清的情况；需要了解实际汇报、决策和晋升机制。",
    riskLevel: null,
    riskCategory: "职责与决策机制",
    warning: "若多方提出冲突要求却缺少决策与升级机制，协作可能受阻。",
    interviewRule:
      "询问重要事项由谁决策、冲突如何处理、绩效如何评定。若确有跨角色协作经验，可说明具体做法；无需为了符合风格而编造工作习惯。",
    counterQuestions: [
      "团队目前日常的汇报与决策机制是怎样的？对于重要技术决策，通常由谁拍板并跟进？",
      "团队内部是否有清晰的技术职级晋升标准与定期的绩效对齐机制？",
    ],
  },
  {
    keyword: "弹性工作制",
    surfaceMeaning: "工作时间可在约定范围内灵活安排，具体规则尚未给出。",
    hiddenMeaning: "可能允许灵活安排上下班时间，但这句话没有说明总工时、核心协作时段或非工作时间的响应要求。",
    riskLevel: null,
    riskCategory: "协作时段与响应边界",
    warning: "若非工作时间仍需持续在线，实际休息时间可能受到影响。",
    interviewRule:
      "核实核心协作时段、值班频率、响应期限与补偿，再表达真实偏好和可用时间。不必声称自己已有未提供的异步协作习惯，也不默认接受随时在线。",
    counterQuestions: [
      "团队平时的核心在线协作时段大概是几点到几点？非核心时段有常规的紧急值班或响应约定吗？",
      "平时沟通协作以异步文档（如飞书/GitLab）为主，还是以即时会议和即时通讯为主？",
    ],
  },
  {
    keyword: "能独立负责业务闭环 / 强自驱",
    surfaceMeaning: "希望成员能主动推进任务并对约定范围内的结果负责。",
    hiddenMeaning: "可能强调自主推进，也可能对支持与责任范围交代不足；独立负责不等于没有带教、协作或升级渠道。",
    riskLevel: null,
    riskCategory: "自主权与协作支持",
    warning: "若个人承担结果责任却缺少相应权限和支持，推进任务可能受阻。",
    interviewRule:
      "确认职责、决策权限、入职支持和遇阻时的升级渠道。若确有自主推进任务的经历，可按实际分工说明；不编造独立负责或项目成功的案例。",
    counterQuestions: [
      "新成员加入团队后，前1-3个月通常有怎样的带教（Mentor）机制或入职落地支持？",
      "在推进跨部门业务协同（比如需要数仓或运维支持）时，团队层面有固化的跨组协同机制吗？",
    ],
  },
  {
    keyword: "团队氛围好，大家像一家人",
    surfaceMeaning: "希望表达团队友好、重视成员之间的协作。",
    hiddenMeaning: "可能是在描述友好的协作氛围，也可能模糊职业边界；这句话本身不能证明薪酬制度、团建安排或团队关系。",
    riskLevel: null,
    riskCategory: "团队协作与职业边界",
    warning: "若情感诉求被用于替代明确的薪酬或休息约定，个人边界可能受影响。",
    interviewRule:
      "可询问协作实例、反馈机制和团建是否自愿，也可正常核实薪酬与休息安排。是否认同这种氛围由自己的真实偏好决定，不必迎合或承诺额外投入。",
    counterQuestions: [
      "团队除了日常业务合作外，平时在技术分享、代码评审（Code Review）等专业建设上有哪些固定实践？",
      "公司在员工专业能力提升和个人成长路径上，通常提供哪些培训或支持资源？",
    ],
  },
  {
    keyword: "薪资面议 / 空间巨大 / 上不封顶",
    surfaceMeaning: "薪酬金额与结构尚需协商，部分收入可能与绩效或提成挂钩。",
    hiddenMeaning: "可能表示薪酬待协商或包含浮动部分，但没有给出可比较的固定金额、保证薪数、计算规则和兑现条件。",
    riskLevel: null,
    riskCategory: "薪酬结构与兑现条件",
    warning: "若把不保证的浮动收入计为固定报酬，实际收入可能低于预期。",
    interviewRule:
      "询问固定与浮动报酬、保证薪数、审批和书面确认条件，再按真实诉求协商。历史奖金仅作参考，不当作未来保证，也不编造其他 Offer 或最低可接受价。",
    counterQuestions: [
      "想请教一下该岗位的薪资结构构成中，固定基本薪资与绩效/年终浮动的比例大概是多少？",
      "过去一到两年中，团队整体绩效考核拿到目标或超额回报的比例大概在什么范围？",
    ],
  },
];

/** 缺失或非法分数保留为未评估，不能生成模型未提供的风险判断 */
function normalizeInt(raw: unknown, min: number, max: number): number | null {
  if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n);
}

function normalizeRiskLevel(raw: unknown): DecodedItem["riskLevel"] {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function strList(raw: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

/** 清洗并验证 AI 生成的黑话解码报告 */
export function normalizeJargonDecoderResult(raw: unknown): JargonDecoderResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const targetSummary = typeof o.target_summary === "string" ? o.target_summary.trim().slice(0, 100) : "岗位/话术综合解码";
  const punchline = typeof o.punchline === "string" ? o.punchline.trim().slice(0, 150) : "字里行间藏玄机，听其言更要观其行。";
  const overallRiskScore = normalizeInt(o.overall_risk_score, 1, 100);

  const ratingsRaw = (o.risk_ratings && typeof o.risk_ratings === "object" ? o.risk_ratings : {}) as Record<string, unknown>;
  const riskRatings: RiskRatings = {
    overtime: normalizeInt(ratingsRaw.overtime, 1, 10),
    stability: normalizeInt(ratingsRaw.stability, 1, 10),
    resources: normalizeInt(ratingsRaw.resources, 1, 10),
    management: normalizeInt(ratingsRaw.management, 1, 10),
  };

  const items: DecodedItem[] = [];
  if (Array.isArray(o.items)) {
    for (const item of o.items.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const keyword = typeof it.keyword === "string" ? it.keyword.trim().slice(0, 30) : "";
      if (!keyword) continue;

      const surfaceMeaning = typeof it.surface_meaning === "string" ? it.surface_meaning.trim().slice(0, 200) : "";
      const hiddenMeaning = typeof it.hidden_meaning === "string" ? it.hidden_meaning.trim().slice(0, 250) : "";
      const riskLevel = normalizeRiskLevel(it.risk_level);
      const riskCategory = typeof it.risk_category === "string" ? it.risk_category.trim().slice(0, 40) : "综合管理";
      const warning = typeof it.warning === "string" ? it.warning.trim().slice(0, 200) : "";
      const interviewRule = typeof it.interview_rule === "string" ? it.interview_rule.trim().slice(0, 300) : "";
      const counterQuestions = strList(it.counter_questions, 4, 150);

      items.push({
        keyword,
        surfaceMeaning,
        hiddenMeaning,
        riskLevel,
        riskCategory,
        warning,
        interviewRule,
        counterQuestions,
      });
    }
  }

  // 明确的空结果是有效判断；缺字段或无效条目不能被当成“没有风险”。
  if (items.length === 0 && !(
    Array.isArray(o.items) && o.items.length === 0 &&
    typeof o.target_summary === "string" && o.target_summary.trim() &&
    typeof o.punchline === "string" && o.punchline.trim() &&
    overallRiskScore !== null && Object.values(riskRatings).every((score) => score !== null) &&
    o.company_profile && typeof o.company_profile === "object" &&
    "culture_summary" in o.company_profile &&
    typeof o.company_profile.culture_summary === "string" && o.company_profile.culture_summary.trim()
  )) return null;

  const profileRaw = (o.company_profile && typeof o.company_profile === "object" ? o.company_profile : {}) as Record<string, unknown>;
  const companyProfile: CompanyProfile = {
    teamStyle: typeof profileRaw.team_style === "string" ? profileRaw.team_style.trim().slice(0, 100) : "未定调团队风格",
    riskFlags: strList(profileRaw.risk_flags, 6, 30),
    cultureSummary: typeof profileRaw.culture_summary === "string" ? profileRaw.culture_summary.trim().slice(0, 250) : "建议在面试中深入摸清团队实际管理节奏。",
  };

  const goldenQuestions = strList(o.golden_questions, 6, 160);

  return {
    targetSummary,
    punchline,
    overallRiskScore,
    riskRatings,
    items,
    companyProfile,
    goldenQuestions: goldenQuestions.length > 0 ? goldenQuestions : items[0]?.counterQuestions || [],
  };
}

/** 校验新生成报告的完整性和原文依据，不使用兼容清洗的默认结论。 */
export function validateGeneratedJargonDecoderResult(raw: unknown, sourceText: string): JargonDecoderResult | null {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(value).every((key) => allowed.includes(key));
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && hasQuestionContent(value);
  const boundedText = (value: unknown, max: number): value is string => text(value) && value.trim().length <= max;
  const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
  const score = (value: unknown, max: number): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
  const questions = (value: unknown, min: number, max: number, maxChars: number): value is string[] => {
    if (!texts(value) || value.length < min || value.length > max ||
        value.some((question) => question.trim().length > maxChars || !hasQuestionContent(question))) return false;
    const keys = value.map((question) => questionComparisonKey(question));
    return keys.every(Boolean) && new Set(keys).size === value.length;
  };

  const limits = JARGON_OUTPUT_LIMITS;
  if (!record(raw) || !hasOnlyKeys(raw, [
      "target_summary", "punchline", "overall_risk_score", "risk_ratings", "items", "company_profile", "golden_questions",
    ]) || !boundedText(raw.target_summary, limits.target_summary) || !boundedText(raw.punchline, limits.punchline) || !score(raw.overall_risk_score, 100) ||
      !record(raw.risk_ratings) || !hasOnlyKeys(raw.risk_ratings, ["overtime", "stability", "resources", "management"]) ||
      !Array.isArray(raw.items) || raw.items.length > limits.max_items ||
      !record(raw.company_profile) || !hasOnlyKeys(raw.company_profile, ["team_style", "risk_flags", "culture_summary"]) ||
      !boundedText(raw.company_profile.team_style, limits.team_style) ||
      !Array.isArray(raw.company_profile.risk_flags) || raw.company_profile.risk_flags.length > limits.max_risk_flags ||
      !raw.company_profile.risk_flags.every((flag) => boundedText(flag, limits.risk_flag)) ||
      new Set((raw.company_profile.risk_flags as string[]).map(textComparisonKey)).size !== raw.company_profile.risk_flags.length ||
      !boundedText(raw.company_profile.culture_summary, limits.culture_summary) ||
      !Array.isArray(raw.golden_questions) ||
      (raw.items.length === 0
        ? raw.golden_questions.length !== 0
        : !questions(raw.golden_questions, limits.min_golden_questions, limits.max_golden_questions, limits.golden_question))) return null;
  const ratings = raw.risk_ratings;
  if (!score(ratings.overtime, 10) || !score(ratings.stability, 10) ||
      !score(ratings.resources, 10) || !score(ratings.management, 10)) return null;
  const dimensionRatings = [ratings.overtime, ratings.stability, ratings.resources, ratings.management] as number[];
  // 没有列出文本线索时，不能同时声称存在需核实或更强的风险信号。
  if (raw.items.length === 0 && (raw.overall_risk_score >= 50 ||
      dimensionRatings.some((rating) => rating >= 4) || raw.company_profile.risk_flags.length !== 0)) return null;
  if (raw.overall_risk_score < 50 && dimensionRatings.some((rating) => rating >= 4)) return null;
  if (raw.overall_risk_score >= 50 && raw.overall_risk_score < 75 && dimensionRatings.every((rating) => rating <= 3)) return null;
  if (raw.overall_risk_score >= 75 && dimensionRatings.every((rating) => rating < 7)) return null;

  const items: DecodedItem[] = [];
  const keywords = new Set<string>();
  for (const item of raw.items) {
    if (!record(item) || !hasOnlyKeys(item, [
      "keyword", "surface_meaning", "hidden_meaning", "risk_level", "risk_category", "warning", "interview_rule", "counter_questions",
    ]) || !text(item.keyword) || !boundedText(item.surface_meaning, limits.surface_meaning) || !boundedText(item.hidden_meaning, limits.hidden_meaning) ||
        !["low", "medium", "high"].includes(item.risk_level as string) || !boundedText(item.risk_category, limits.risk_category) ||
        !boundedText(item.warning, limits.warning) || !boundedText(item.interview_rule, limits.interview_rule) ||
        !questions(item.counter_questions, limits.min_counter_questions, limits.max_counter_questions, limits.counter_question)) return null;
    const keyword = resolveUntrustedSourceQuote(item.keyword.trim(), sourceText);
    if (keyword === null || !text(keyword)) return null;
    const keywordKey = textComparisonKey(keyword);
    if (keywords.has(keywordKey)) return null;
    keywords.add(keywordKey);
    items.push({
      keyword, surfaceMeaning: item.surface_meaning.trim(), hiddenMeaning: item.hidden_meaning.trim(),
      riskLevel: item.risk_level as DecodedItem["riskLevel"], riskCategory: item.risk_category.trim(),
      warning: item.warning.trim(), interviewRule: item.interview_rule.trim(),
      counterQuestions: item.counter_questions.map((question) => question.trim()),
    });
  }
  return {
    targetSummary: raw.target_summary.trim(), punchline: raw.punchline.trim(), overallRiskScore: raw.overall_risk_score,
    riskRatings: { overtime: ratings.overtime, stability: ratings.stability, resources: ratings.resources, management: ratings.management },
    items,
    companyProfile: {
      teamStyle: raw.company_profile.team_style.trim(), riskFlags: raw.company_profile.risk_flags.map((flag) => flag.trim()),
      cultureSummary: raw.company_profile.culture_summary.trim(),
    },
    goldenQuestions: raw.golden_questions.map((question) => question.trim()),
  };
}

function storedRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function storedTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 历史文本按完整展示结构读取，不截断或补造；无效旧评分仍保留为未评估。 */
export function parseJargonDecoderResult(json: string): JargonDecoderResult | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!storedRecord(parsed) || typeof parsed.targetSummary !== "string" || typeof parsed.punchline !== "string" ||
      !Array.isArray(parsed.items) || !parsed.items.every((item) => storedRecord(item) &&
        ["keyword", "surfaceMeaning", "hiddenMeaning", "riskCategory", "warning", "interviewRule"]
          .every((key) => typeof item[key] === "string") && storedTextList(item.counterQuestions)) ||
      !storedRecord(parsed.companyProfile) || typeof parsed.companyProfile.teamStyle !== "string" ||
      typeof parsed.companyProfile.cultureSummary !== "string" || !storedTextList(parsed.companyProfile.riskFlags) ||
      !storedTextList(parsed.goldenQuestions)) return null;
    const stored = parsed as Omit<JargonDecoderResult, "riskRatings"> & { riskRatings?: unknown };
    const ratings = storedRecord(stored.riskRatings) ? stored.riskRatings : {};
    return {
      ...stored,
      items: stored.items.map((item) => ({ ...item, riskLevel: normalizeRiskLevel(item.riskLevel) })),
      overallRiskScore: normalizeInt(stored.overallRiskScore, 1, 100),
      riskRatings: {
        overtime: normalizeInt(ratings.overtime, 1, 10),
        stability: normalizeInt(ratings.stability, 1, 10),
        resources: normalizeInt(ratings.resources, 1, 10),
        management: normalizeInt(ratings.management, 1, 10),
      },
    };
  } catch {
    return null;
  }
}
