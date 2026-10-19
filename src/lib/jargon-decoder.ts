/** 面试黑话与公司风格暗号解码器的领域类型、清洗规范与预置经典词库 */

export type DecodedItem = {
  /** 识别出的黑话/暗号关键词（如“抗压能力强”、“拥抱变化”） */
  keyword: string;
  /** 表面官方含义/说辞 */
  surfaceMeaning: string;
  /** 背后真实潜台词（揭露内幕） */
  hiddenMeaning: string;
  /** 风险等级：low=轻微, medium=中等警戒, high=高危红线；null=未评估 */
  riskLevel: "low" | "medium" | "high" | null;
  /** 风险类型（如：加班过劳、业务动荡、资源匮乏、管理混乱、考核苛刻） */
  riskCategory: string;
  /** 踩坑警示（入职后可能真实面临的坑） */
  warning: string;
  /** 面试应对潜规则（被问到此话题时的高分作答策略与禁忌） */
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
  /** 公司/团队风格画像（一句话犀利定调） */
  teamStyle: string;
  /** 潜在雷区/红线标签列表 */
  riskFlags: string[];
  /** 团队文化与日常工作节奏简评 */
  cultureSummary: string;
};

export type JargonDecoderResult = {
  /** 岗位/话术速写一句话 */
  targetSummary: string;
  /** 综合一句话辛辣总结 */
  punchline: string;
  /** 综合风险指数 1-100 */
  overallRiskScore: number | null;
  /** 4维度风险评分 */
  riskRatings: RiskRatings;
  /** 解析出的黑话潜台词列表 */
  items: DecodedItem[];
  /** 团队风格画像 */
  companyProfile: CompanyProfile;
  /** 面试终局精选：最推荐问出的 3-5 个王牌反向提问 */
  goldenQuestions: string[];
};

/** 预设经典黑话词典库（可用于首页秒查与示范体验） */
export const PRESET_JARGONS: DecodedItem[] = [
  {
    keyword: "抗压能力强",
    surfaceMeaning: "能够适应高强度节奏，在紧急任务与严苛节点下保持高效产出。",
    hiddenMeaning: "无偿加班是家常便饭，缺乏合理排期机制，需求突发随时插队，甚至一人顶两三人用。",
    riskLevel: "high",
    riskCategory: "加班过劳与不合理排期",
    warning: "大概率存在常态化‘996’或随时响应机制，身心健康容易透支，且加班通常缺乏对等补偿。",
    interviewRule:
      "不要回答‘我完全不介意加班’（容易被当软柿子），也不要强硬回绝。高分策略：强调‘科学管理压力与预期’，表达理解业务突发峰值，但更注重通过敏捷复盘、风险前置与技术沉淀降低无序救火。",
    counterQuestions: [
      "请问团队通常在什么业务节点下会出现集中高强度攻坚？平时版本发布的标准周期大概是多久？",
      "如果上下游出现突发紧急变更，团队内部通常走怎样的优先级评估和排期协调流程？",
    ],
  },
  {
    keyword: "拥抱变化",
    surfaceMeaning: "心态开放积极，能够敏锐顺应公司战略演进与市场新机遇。",
    hiddenMeaning: "业务方向反复横跳，领导想法朝令夕改，上一季度的投入可能下季度直接废弃，KPI 随时重置。",
    riskLevel: "high",
    riskCategory: "业务动荡与组织混乱",
    warning: "沉淀的技术或业务成果很难有长效收益，绩效评价标准不稳定，人员换血频率高。",
    interviewRule:
      "展示高度的灵活性与全局业务视角。高分策略：阐述自己曾在快速演进业务中，如何通过模块化解耦、配置化设计等架构手段，让系统既能迅速响应新需求，又能保证主干资产不被打烂。",
    counterQuestions: [
      "请问当前团队负责的核心业务线，今年最核心的 OKR 或战略优先级目标是什么？近期有经历过较大转向吗？",
      "当产品或运营方向产生突发调整时，团队通常如何平衡技术架构重构与业务快速交付？",
    ],
  },
  {
    keyword: "有从 0 到 1 经验",
    surfaceMeaning: "具备拓荒开荒精神，能自主搭建全新体系与产品架构。",
    hiddenMeaning: "基建极其薄弱，无历史文档，前人代码不可考，缺乏协作资源，需要你一人包揽架构、开发、运维甚至测试。",
    riskLevel: "high",
    riskCategory: "资源匮乏与拓荒风险",
    warning: "没有现成脚手架和自动化管线，脏活累活全包，试错成本完全转嫁在个人头上，一旦业务跑不通容易背锅。",
    interviewRule:
      "展现系统性建构能力与踩坑教训。高分策略：重点讲你如何做‘最小可行性落地（MVP）’、如何做好选型评估以及如何逐步沉淀规范，突出你‘既能动手填坑，又能建章立制’的能力。",
    counterQuestions: [
      "针对这个从 0 到 1 的方向，目前团队配置的专属资源（前后端、产品、预算等）已到位的有哪些？",
      "公司管理层对该新业务线的试错周期预期是多久？第一阶段验收的核心指标（里程碑）是什么？",
    ],
  },
  {
    keyword: "扁平化管理",
    surfaceMeaning: "沟通链路短，没有繁冗汇报层级，氛围开放包容。",
    hiddenMeaning: "管理制度缺位，权责边界模糊，老板直接微观插手细节，晋升缺乏明确职级晋升通道，全凭老板喜好。",
    riskLevel: "medium",
    riskCategory: "管理混乱与晋升不透明",
    warning: "每个人都在当接口人，扯皮时找不到责任归属方，且容易被多头指挥。",
    interviewRule:
      "突出自驱与向上沟通管理能力。强调自己在跨角色协作时，主动理顺协作链路、对齐产出文档并推进结论闭环的习惯。",
    counterQuestions: [
      "团队目前日常的汇报与决策机制是怎样的？对于重要技术决策，通常由谁拍板并跟进？",
      "团队内部是否有清晰的技术职级晋升标准与定期的绩效对齐机制？",
    ],
  },
  {
    keyword: "弹性工作制",
    surfaceMeaning: "上下班时间灵活自主，不机械打卡，注重工作成果。",
    hiddenMeaning: "早上弹性上班，晚上弹性不下班；下班后和周末钉钉/微信信息随时要回，生活与工作界限彻底模糊。",
    riskLevel: "medium",
    riskCategory: "隐性加班与边界感侵占",
    warning: "虽然早上不查迟到，但半夜突发报警或群里艾特要求立时处理的概率大幅上升。",
    interviewRule:
      "表达对目标结果导向的认同，同时体现自我时间管理与异步协作能力，说明自己习惯通过任务看板清晰透明化工作进度。",
    counterQuestions: [
      "团队平时的核心在线协作时段大概是几点到几点？非核心时段有常规的紧急值班或响应约定吗？",
      "平时沟通协作以异步文档（如飞书/GitLab）为主，还是以即时会议和即时通讯为主？",
    ],
  },
  {
    keyword: "能独立负责业务闭环 / 强自驱",
    surfaceMeaning: "主人翁意识强，能端到端对业务结果负责，无需保姆式带教。",
    hiddenMeaning: "没人带你也没人协助你，跨部门沟通全靠个人去刷脸求人，出问题时责任全在个人闭环。",
    riskLevel: "medium",
    riskCategory: "支持匮乏与责任倒挂",
    warning: "刚入职缺乏必要上手引导，考核标准以结果定生死，容易陷入‘孤军奋战’的窘境。",
    interviewRule:
      "展示闭环推进力与协同共赢。讲述自己过往如何通过主动拆解里程碑、主动拉齐上下游资源、主动定期向主管汇报风险来推动项目成功的案例。",
    counterQuestions: [
      "新成员加入团队后，前1-3个月通常有怎样的带教（Mentor）机制或入职落地支持？",
      "在推进跨部门业务协同（比如需要数仓或运维支持）时，团队层面有固化的跨组协同机制吗？",
    ],
  },
  {
    keyword: "团队氛围好，大家像一家人",
    surfaceMeaning: "人际关系简单纯粹，同事相处融洽，互帮互助。",
    hiddenMeaning: "公私不分，喜欢用‘感情牌’代替合理的薪酬激励与加班费，动辄搞低质量情感绑架或周末团建。",
    riskLevel: "low",
    riskCategory: "薪酬福利低与情感绑架",
    warning: "谈钱伤感情，调薪难度大，用‘我们是一个伐木累’的温情包装压榨本色。",
    interviewRule:
      "礼貌回应团队协作的重要性，同时把话题自然引导到‘基于共同目标与高标准专业度的一流团队合作’，体现职业化素养。",
    counterQuestions: [
      "团队除了日常业务合作外，平时在技术分享、代码评审（Code Review）等专业建设上有哪些固定实践？",
      "公司在员工专业能力提升和个人成长路径上，通常提供哪些培训或支持资源？",
    ],
  },
  {
    keyword: "薪资面议 / 空间巨大 / 上不封顶",
    surfaceMeaning: "根据个人能力定制待遇，优秀者享有极具竞争力的报酬回报。",
    hiddenMeaning: "基本底薪远低于市场平均，所谓空间巨大全靠画饼或极难达成的提成绩效指标。",
    riskLevel: "high",
    riskCategory: "薪资陷阱与画饼承诺",
    warning: "年终奖或浮动部分缺少白纸黑字的明确兑现细则，招聘阶段压价概率高。",
    interviewRule:
      "在终面或 HR 面环节，态度温和但坚定地了解薪酬结构（基本薪资 vs 浮动绩效比例、年终基准月数及往年实际达成中位数）。",
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

  // 至少识别出 1 条有效暗号
  if (items.length === 0) return null;

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

/** 解析保存在数据库中的 JSON 字符串 */
export function parseJargonDecoderResult(json: string): JargonDecoderResult | null {
  try {
    const parsed = JSON.parse(json) as JargonDecoderResult;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) return null;
    return {
      ...parsed,
      items: parsed.items.map((item) => ({ ...item, riskLevel: normalizeRiskLevel(item.riskLevel) })),
      overallRiskScore: normalizeInt(parsed.overallRiskScore, 1, 100),
      riskRatings: {
        overtime: normalizeInt(parsed.riskRatings?.overtime, 1, 10),
        stability: normalizeInt(parsed.riskRatings?.stability, 1, 10),
        resources: normalizeInt(parsed.riskRatings?.resources, 1, 10),
        management: normalizeInt(parsed.riskRatings?.management, 1, 10),
      },
    };
  } catch {
    return null;
  }
}
