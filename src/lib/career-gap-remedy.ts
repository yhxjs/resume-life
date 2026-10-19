/** 离职原因与空窗期高情商重塑工坊的核心类型、数据清洗与经典对策库 */

export type ScenarioType = "resignation" | "gap" | "both";
export type PersonaStyle = "pragmatic" | "driven" | "composed";

export type ScriptVersion = {
  /** 方案标签，如 "四两拨千斤（精炼30秒版）" */
  label: string;
  /** 适用场景说明，如 "适合HR初筛或电调，不节外生枝" */
  applicableScene: string;
  /** 完整可直接口述的话术内容 */
  script: string;
  /** 核心逻辑拆解（为什么这么说能加分） */
  keyPoints: string[];
};

export type HrDrill = {
  /** HR刁钻连环追问问题 */
  question: string;
  /** HR此提问背后的真实顾虑与测试点 */
  hrConcern: string;
  /** 破局思路与高情商接招话术 */
  bestResponse: string;
};

export type ResignationGapRemedyResult = {
  /** 核心定调与场景标签（如：“被动裁员向组织瘦身转型”、“裸辞gap向敏捷技术充电沉淀”） */
  title: string;
  /** 诊断一句话金句：点出重塑的核心抓手与心态转变 */
  punchline: string;
  /** HR心理测谎仪：剖析HR在听真实情况时的潜意识隐忧 */
  hrMindsetAnalysis: {
    coreConcerns: string[];
    riskPoints: string[];
    whatHrWantsToHear: string;
  };
  /** 重塑底层四步公式：认同事实 + 归因正向 + 沉淀赋能 + 动机绑定 */
  reframeFormula: {
    factAcknowledgment: string;
    positiveAttribution: string;
    growthAndValue: string;
    motivationAlignment: string;
  };
  /** 三套实战话术方案 */
  scripts: {
    concise: ScriptVersion;
    detailed: ScriptVersion;
    pivoting: ScriptVersion;
  };
  /** HR深挖连环追问对策预演 */
  drills: HrDrill[];
  /** 绝对禁忌红线清单（千万不可脱口而出的雷区） */
  forbiddenList: string[];
  /** 面试点睛小建议 */
  closingTips: string[];
};

/** 经典高频离职与空窗期对策预置条目 */
export type PresetRemedy = {
  id: string;
  category: "resignation" | "gap";
  title: string;
  badge: string;
  rawPain: string;
  hrConcern: string;
  reframeAngle: string;
  quickScript: string;
  deepScript: string;
  forbidden: string;
};

export const PRESET_REMEDIES: PresetRemedy[] = [
  {
    id: "layoff-biz-cut",
    category: "resignation",
    title: "公司业务线整体关停 / 规模性裁员",
    badge: "非个人绩效",
    rawPain: "整个部门或业务线都被砍了，被动拿 N+1 赔偿离职，担心 HR 以为是我个人绩效垫底被优化。",
    hrConcern: "是不是在团队内部被列为可裁人员？沟通协作或技术能力是否落后？",
    reframeAngle: "强调不可抗力与组织战略收缩，展示在前团队的良好评价与站好最后一班岗的职业素养。",
    quickScript:
      "前司因为宏观战略调整，全面缩减了我们所负责的创新出海业务线，属于组织架构的整体优化。在职期间我的绩效一直处于团队前列，并且非常负责地配合完成了所有系统交接与平稳过渡。这次离职也让我更清晰地希望在主营业务成熟、战略坚定的平台长期深耕。",
    deepScript:
      "前司当时面对整体大环境调整，管理层决定做战略聚焦，收缩了包括我们组在内的整条创新业务线。离职并非个人绩效原因，事实上在此之前我主导的核心模块按期高质量交付，主管和团队对我的专业度都非常认可，即便在部门裁撤阶段，我也主动留到最后完成知识沉淀与文档交接。这段经历让我对业务抗风险能力有了更深理解，现在我希望把积累的全栈交付能力沉淀到像贵司这样赛道稳健、业务具备护城河的团队中。",
    forbidden: "抱怨前司管理层愚蠢盲目扩张、反复倾诉被裁的怨气或强调赔偿金额。",
  },
  {
    id: "overtime-burnout",
    category: "resignation",
    title: "常态无序加班 / 身体透支与严重内耗",
    badge: "可持续效能",
    rawPain: "前司天天加班到凌晨，纯粹是管理混乱和无休止开会填坑，身体吃不消被迫提离职。",
    hrConcern: "抗压能力是不是不行？不能接受快节奏？一遇到紧急项目就会撂挑子？",
    reframeAngle: "把‘不能加班’重塑为‘追求目标导向的高能效交付与可持续产出’，认同健康攻坚但拒绝低效内耗。",
    quickScript:
      "我非常认同在关键业务节点或上线攻坚时的高投入，但前司存在较长期的无序管理与低效扯皮，导致时间被琐碎内耗切碎。我更看重以结果和敏捷为导向的高效协同，希望加入一个工程素养高、节奏有条理的团队，把精力集中在真正创造业务价值的技术攻坚上。",
    deepScript:
      "过往遇到紧急版本或大促攻坚，我一直都是冲在前面的主力，并不排斥高强度拼搏。选择离开主要是我发现前司常态化处于‘无序救火’的循环中——排期频繁临时插单，大量时间被无结论的会议消耗，缺乏系统复盘机制。我是一个推崇‘用工程规范提效、用自动化管线降本’的人。因此我希望转换到一个管理成熟度更高、推崇敏捷高效交付的平台，通过清晰的规划和高质量架构实现长期的良性产出。",
    forbidden: "直接吐槽‘前司经常加班到半夜把我身体搞垮了’、表现出对加班的绝对抵触与反感。",
  },
  {
    id: "pay-cut-delay",
    category: "resignation",
    title: "公司降薪 / 拖欠工资 / 福利断崖",
    badge: "经营风险合规",
    rawPain: "公司现金流暴雷，延发工资、强制打折，逼大家主动走人。",
    hrConcern: "离开是否由于情绪冲动？是否急于找下家而对薪酬缺乏客观理性评估？",
    reframeAngle: "客观陈述事实，不带个人情绪攻击，强调对自身稳定生活与职业专注的负责态度。",
    quickScript:
      "前司在经营上出现了一定流动性压力，并在薪资兑现与福利机制上做出了较大幅度的收缩。作为职业人，我尊重企业的经营抉择，但也需要一份健康可持续的工作来维持全身心专注的职业状态。因此在站好交接班后，我选择主动寻找一家现金流健康、制度规范的正规平台。",
    deepScript:
      "前司近半年受到整体行业资金面的影响，运营策略发生了较大调整，薪资发放周期和福利机制多次推迟。我在职期间依然尽职尽责完成了项目迭代，但考虑到家庭财务稳定与对长远事业的专注度，我认为理性的选择是重新出发。贵司在业内一直以财务稳健、经营踏实著称，这也是我非常渴望加入的原因。",
    forbidden: "大肆宣扬前司老板品行不端、言辞过激地指责前雇主违法违规。",
  },
  {
    id: "career-ceiling",
    category: "resignation",
    title: "技术停滞 / 业务边缘化 / 触及天花板",
    badge: "主动求索成长",
    rawPain: "天天维护祖传屎山代码，业务没有新增长点，干了两年感觉废了，学不到新东西。",
    hrConcern: "是不是对日常维护工作挑肥拣瘦？没有自我驱动力自救？跳槽欲望是不是太频繁？",
    reframeAngle: "表达对原有业务的感恩与交付成果，将离职定位为‘主动打破舒适圈，寻求更具挑战的业务场景’。",
    quickScript:
      "在前司的两年多时间里，我将原有系统从稳定性到性能瓶颈做了一整套治理，业务体系已经进入非常平稳的维护期。我希望在自己技术状态最好的阶段跳出舒适圈，接触更具技术深度、更大规模并发或更具想象力的新业务，继续激发自己的潜能。",
    deepScript:
      "在前司期间我很感谢团队的信任，让我主导了老系统的模块重构与稳定性建设，核心链路的故障率降低了40%，我也总结沉淀了一套规范文档。但随着系统进入高度稳定的收割期，后续更多是常规配置化支持。我是一个有较强技术好奇心与突破欲望的人，与其在舒适区躺平，我更希望能投身到正在高速发展或技术挑战更复杂的前沿业务中，比如贵司目前深耕的这个方向。",
    forbidden: "贬低前司技术落后、吐槽老项目全是屎山没人管。",
  },
  {
    id: "gap-recharge",
    category: "gap",
    title: "裸辞休息 / 调整身心状态（3~6个月）",
    badge: "主动沉淀充电",
    rawPain: "上份工作连轴转了三年身心俱疲，裸辞后休息旅行了两个月，顺便学了点新框架，担心被当成懒散。",
    hrConcern: "是不是散漫缺乏规划？重回高强度工作能不能迅速上膛？专业技能是否生疏？",
    reframeAngle: "将空白期定义为‘有计划的人生中场复盘与系统充电’，拿出具体的学习产出与充沛的精神面貌。",
    quickScript:
      "在连续高强度一线开发三年后，我主动给自己规划了一段有节奏的缓冲期：前一个月陪家人旅行调理身心，后两到三个月我系统通读了微服务架构与 AI 工具链实战，并独立动手做了两个完整项目 demo。目前我的精力和技术状态都处于最佳峰值，随时可以全情投入到新的攻坚战中。",
    deepScript:
      "过去几年我一直奔跑在一线，很少有整块时间站在更高视角审视自己的知识架构。这次主动调整是深思熟虑的决定：一方面彻底让身心归零，建立更充沛的体能；另一方面，我制定了清晰的阶段性学习计划，对过去做过的业务进行深度架构复盘，同时深入学习了全栈开发最新技术栈。通过这次充电，不仅技术视野更开阔，心态也更加成熟坚定，现在的我已经做好了全身心迎接新挑战的充分准备。",
    forbidden: "回答‘就是想躺平玩一玩，没想到现在工作这么难找才找了几个月’。",
  },
  {
    id: "gap-exam-retry",
    category: "gap",
    title: "考公 / 考研备战未上岸重回职场",
    badge: "坚定职业终局",
    rawPain: "毕业或离职后全职备考了一年，最后没考上，不得不重新找工作，怕被嫌弃心不定。",
    hrConcern: "是不是骑驴找马？下半年会不会又去请假备战？对互联网/企业岗位是否缺乏热情？",
    reframeAngle: "坦然接纳人生探索，清晰说明‘心结已解、全力以赴’，突出备考培养的严谨逻辑与抗压韧性。",
    quickScript:
      "那段时间我为了不留青春遗憾，给自己设了一定期限全职冲刺了一次研究生考试。虽然结果有偏差，但经历这段极致自律的高强度备考，我不仅拓宽了认知，更彻底明确了我的真正热情依然在通过代码解决实际业务问题的职场中。我已经彻底翻过这一页，未来几年将百分百专注于在企业中打磨专业价值，绝不会有二心。",
    deepScript:
      "备考是我在特定阶段做出的自我挑战，也是对自己自驱与专注力的一次极限测试。在备战过程中我养成了极高强度的抗压心智与深度复盘习惯。遗憾虽有，但我非常认同‘行胜于言’，这次尝试让我彻底厘清了自己适合什么：我更喜欢在快速反馈、业务落地的敏捷实战中获得成就感。现在我的心态极其笃定，已经把全部重心重新切换回技术开发，能够以更加沉稳扎实的心态对待每一项业务需求。",
    forbidden: "表现出强烈的懊恼沮丧，或者含糊其辞说‘如果后面有机会可能还会再试一次’。",
  },
  {
    id: "gap-family-care",
    category: "gap",
    title: "照料家庭 / 个人健康调理恢复",
    badge: "后顾之忧已除",
    rawPain: "因为家中有长辈生病或自己做了个手术需要休养调理，在家待了几个月。",
    hrConcern: "家庭或身体问题是否会持续影响工作出勤？精力能否跟上高强度要求？",
    reframeAngle: "真诚明确地告知情况，核心关键在于‘事情已彻底稳妥解决，身体完全康复，无任何后顾之忧’。",
    quickScript:
      "那段时间主要是因为家中长辈突发健康问题需要手术陪护，作为子女我必须承担起家庭责任。目前老人已经彻底康复，生活完全能自理，后顾之忧已经全部解决。在这期间我也一直关注着行业动态，现在个人的精力与时间可以百分之百无保留地投入到新团队的工作中。",
    deepScript:
      "前几个月家里有一段特殊的家庭照料期，我选择暂时放慢脚步陪护家人渡过难关。我很欣慰这段时间的付出让家庭恢复了平稳，目前所有健康问题已完全恢复常态，家庭支持非常充分。这段经历不仅强化了我的责任担当，也让我更加珍惜工作机会。目前我各方面状态都调整到了最佳，能够全神贯注、毫无牵挂地拥抱高强度的业务挑战。",
    forbidden: "把家里的悲惨遭遇描述得过于繁复煽情，或者留下‘后续可能还会经常要跑医院’的疑虑。",
  },
  {
    id: "gap-entrepreneurship",
    category: "gap",
    title: "创业折腾 / 自由职业 / 副业试错",
    badge: "复合商业视角",
    rawPain: "和朋友一起搞独立开发或开工作室，结果搞了半年入不敷出失败了，重新回来打工。",
    hrConcern: "野心是不是太大不安分？在团队里会不会不服管？是不是拿公司当跳板积累资源？",
    reframeAngle: "突出端到端商业视角、对成本和业务价值的敬畏，以及深刻理解团队协同的稀缺性与平台价值。",
    quickScript:
      "那段时间我和朋友尝试做了一款面向垂类市场的工具产品。这半年的创业试错虽然最终因获客成本过高未能持续，但让我从单纯的开发思维跳出来，完整经历了商业定位、成本控制和用户交付全流程。这段宝贵经历让我更加懂得如何站在老板和业务视角思考技术 ROI，也让我更渴望依托大平台的资源杠杆，在成熟的体系里打大胜仗。",
    deepScript:
      "这次创业尝试对我来说是一次极其珍贵的‘全景式商业洗礼’。过去做研发更多关注代码怎么写得优雅，而独立负责项目后，我深刻体会到了现金流、合规风控、跨角色协同以及平台基建的巨大价值。它极大地提升了我的大局观与危机意识。现在我深知自己的核心长板与热情在于大规模工程实现与架构落地，回归职场是我深思熟虑后的长线规划，我能比一般工程师更加主动地对业务最终结果负责。",
    forbidden: "给人留下‘等我融到钱或者找到好点子我还要去创业’的印象，或者抱怨合作方坑了自己。",
  },
];

function strList(raw: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeScript(raw: unknown, defaultLabel: string): ScriptVersion {
  if (!raw || typeof raw !== "object") {
    return {
      label: defaultLabel,
      applicableScene: "通用面试沟通场合",
      script: "陈述事实，展现成熟职业素养。",
      keyPoints: ["坦诚归因", "展现价值"],
    };
  }
  const o = raw as Record<string, unknown>;
  return {
    label: typeof o.label === "string" ? o.label.trim().slice(0, 40) : defaultLabel,
    applicableScene: typeof o.applicable_scene === "string" ? o.applicable_scene.trim().slice(0, 100) : "适合常规面试场景",
    script: typeof o.script === "string" ? o.script.trim().slice(0, 800) : "",
    keyPoints: strList(o.key_points, 5, 100),
  };
}

/** 清洗并验证 AI 生成的高情商重塑报告 */
export function normalizeRemedyResult(raw: unknown): ResignationGapRemedyResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const title = typeof o.title === "string" ? o.title.trim().slice(0, 60) : "个人经历高情商重塑方案";
  const punchline = typeof o.punchline === "string" ? o.punchline.trim().slice(0, 120) : "真诚是最大的必杀技，高情商是事实的正向着色。";

  // HR 心理分析
  const hrRaw = (o.hr_mindset_analysis && typeof o.hr_mindset_analysis === "object" ? o.hr_mindset_analysis : {}) as Record<string, unknown>;
  const hrMindsetAnalysis = {
    coreConcerns: strList(hrRaw.core_concerns, 5, 100),
    riskPoints: strList(hrRaw.risk_points, 5, 100),
    whatHrWantsToHear:
      typeof hrRaw.what_hr_wants_to_hear === "string"
        ? hrRaw.what_hr_wants_to_hear.trim().slice(0, 200)
        : "HR 期待听到你情绪稳定、复盘深刻，且对新岗位拥有真实且持久的投入度。",
  };

  // 重塑底层四步公式
  const fRaw = (o.reframe_formula && typeof o.reframe_formula === "object" ? o.reframe_formula : {}) as Record<string, unknown>;
  const reframeFormula = {
    factAcknowledgment: typeof fRaw.fact_acknowledgment === "string" ? fRaw.fact_acknowledgment.trim().slice(0, 200) : "客观陈述事实，不粉饰不掩盖",
    positiveAttribution: typeof fRaw.positive_attribution === "string" ? fRaw.positive_attribution.trim().slice(0, 200) : "归因于环境与职业选择，不埋怨他人",
    growthAndValue: typeof fRaw.growth_and_value === "string" ? fRaw.growth_and_value.trim().slice(0, 200) : "突出空窗/离职期间的自我沉淀与赋能",
    motivationAlignment: typeof fRaw.motivation_alignment === "string" ? fRaw.motivation_alignment.trim().slice(0, 200) : "将落脚点精准导向目标岗位的发展契机",
  };

  // 三套话术
  const scriptsRaw = (o.scripts && typeof o.scripts === "object" ? o.scripts : {}) as Record<string, unknown>;
  const scripts = {
    concise: normalizeScript(scriptsRaw.concise, "四两拨千斤（精炼 30 秒版）"),
    detailed: normalizeScript(scriptsRaw.detailed, "深度坦诚与正向赋能版（1 分钟版）"),
    pivoting: normalizeScript(scriptsRaw.pivoting, "攻守兼备·话题导流版"),
  };

  // 确保至少有一套完整话术
  if (!scripts.concise.script && !scripts.detailed.script) {
    return null;
  }

  // 追问演练
  const drills: HrDrill[] = [];
  if (Array.isArray(o.drills)) {
    for (const d of o.drills.slice(0, 5)) {
      if (!d || typeof d !== "object") continue;
      const drillObj = d as Record<string, unknown>;
      const question = typeof drillObj.question === "string" ? drillObj.question.trim().slice(0, 150) : "";
      if (!question) continue;
      drills.push({
        question,
        hrConcern: typeof drillObj.hr_concern === "string" ? drillObj.hr_concern.trim().slice(0, 150) : "考察反应与真实心态",
        bestResponse: typeof drillObj.best_response === "string" ? drillObj.best_response.trim().slice(0, 400) : "",
      });
    }
  }

  const forbiddenList = strList(o.forbidden_list, 8, 120);
  const closingTips = strList(o.closing_tips, 5, 120);

  return {
    title,
    punchline,
    hrMindsetAnalysis,
    reframeFormula,
    scripts,
    drills,
    forbiddenList: forbiddenList.length > 0 ? forbiddenList : ["切忌在面试中发泄对前司或前领导的负面情绪"],
    closingTips: closingTips.length > 0 ? closingTips : ["表达时保持眼神交流与从容语速，体现情绪价值与专业素养"],
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

/** 校验模型输出完整性并转换为展示结构。 */
export function validateGeneratedRemedyResult(raw: unknown): ResignationGapRemedyResult | null {
  if (!record(raw)) return null;
  if (!nonEmptyString(raw.title) || !nonEmptyString(raw.punchline)) return null;

  const mindset = raw.hr_mindset_analysis;
  if (!record(mindset) || !nonEmptyStringList(mindset.core_concerns) || !nonEmptyStringList(mindset.risk_points) || !nonEmptyString(mindset.what_hr_wants_to_hear)) {
    return null;
  }
  const formula = raw.reframe_formula;
  if (
    !record(formula) ||
    !nonEmptyString(formula.fact_acknowledgment) ||
    !nonEmptyString(formula.positive_attribution) ||
    !nonEmptyString(formula.growth_and_value) ||
    !nonEmptyString(formula.motivation_alignment)
  ) return null;

  const scripts = raw.scripts;
  if (!record(scripts)) return null;
  for (const key of ["concise", "detailed", "pivoting"] as const) {
    const script = scripts[key];
    if (!record(script) || !nonEmptyString(script.label) || !nonEmptyString(script.applicable_scene) || !nonEmptyString(script.script) || !nonEmptyStringList(script.key_points)) {
      return null;
    }
  }

  if (!Array.isArray(raw.drills) || raw.drills.length === 0) return null;
  for (const drill of raw.drills) {
    if (!record(drill) || !nonEmptyString(drill.question) || !nonEmptyString(drill.hr_concern) || !nonEmptyString(drill.best_response)) return null;
  }
  if (!nonEmptyStringList(raw.forbidden_list) || !nonEmptyStringList(raw.closing_tips)) return null;
  return normalizeRemedyResult(raw);
}

/** 解析保存在数据库中的 JSON 字符串 */
export function parseRemedyResult(json: string): ResignationGapRemedyResult | null {
  try {
    const parsed = JSON.parse(json) as ResignationGapRemedyResult;
    if (!parsed || typeof parsed !== "object" || !parsed.scripts) return null;
    return parsed;
  } catch {
    return null;
  }
}
