/** 离职与空窗沟通准备的核心类型、数据清洗与示例库 */
import { hasQuestionContent, questionComparisonKey } from "./question-normalization";

export type ScenarioType = "resignation" | "gap" | "both";
export type PersonaStyle = "pragmatic" | "driven" | "composed";

export type ScriptVersion = {
  /** 方案标签，如 "精炼说明版" */
  label: string;
  /** 适用场景说明，如 "适合 HR 初步沟通或电调" */
  applicableScene: string;
  /** 完整可直接口述的话术内容 */
  script: string;
  /** 表达思路与事实限定说明 */
  keyPoints: string[];
};

export type HrDrill = {
  /** 基于已知经历的可能追问 */
  question: string;
  /** 该问题可能核实的信息，不代表已知招聘方真实心理 */
  hrConcern: string;
  /** 有事实依据的回答示例，未知内容明确待补充 */
  bestResponse: string;
};

export type ResignationGapRemedyResult = {
  /** 与已知经历相符的方案标题 */
  title: string;
  /** 概括事实说明与沟通重点 */
  punchline: string;
  /** 材料支持的可能招聘关注点与尚待澄清的信息 */
  hrMindsetAnalysis: {
    coreConcerns: string[];
    riskPoints: string[];
    whatHrWantsToHear: string;
  };
  /** 说明事实、客观解释、已知行动与岗位衔接；缺失信息不补造 */
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
  /** 可能追问与回答示例 */
  drills: HrDrill[];
  /** 应避免的失实表达、无依据承诺或人身攻击 */
  forbiddenList: string[];
  /** 面试点睛小建议 */
  closingTips: string[];
};

/** 场景示例仅依据 rawPain 改写；个人细节、成果和计划未知时保留待补充。 */
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
    badge: "说明裁撤范围",
    rawPain: "整个部门或业务线都被砍了，被动拿 N+1 赔偿离职，担心 HR 以为是我个人绩效垫底被优化。",
    hrConcern: "招聘方可能核实裁撤范围、离职时间及原岗位职责；整体裁撤本身不能说明个人绩效。",
    reframeAngle: "说明业务线整体关停与被动离职的事实；如需补充绩效、交接或个人贡献，只使用可核实的信息。",
    quickScript:
      "我所在的部门或业务线整体被裁撤，我因此被动离职。关于之前的岗位职责和具体工作，我可以结合实际经历进一步说明：[待补充：真实职责与工作内容]。",
    deepScript:
      "这次离职发生在整个部门或业务线被裁撤时，属于被动离职，公司按 N+1 给予了补偿。此前我在岗位上负责的工作是：[待补充：实际职责及可核实的工作实例]。如果需要进一步了解我的工作情况，可以从这些具体经历展开讨论。",
    forbidden: "不要编造绩效排名、主管评价、主导贡献或交接成果；赔偿可按需要如实说明，避免无依据揣测裁撤动机或攻击个人。",
  },
  {
    id: "overtime-burnout",
    category: "resignation",
    title: "常态无序加班 / 身体透支与严重内耗",
    badge: "可持续效能",
    rawPain: "前司天天加班到凌晨，纯粹是管理混乱和无休止开会填坑，身体吃不消被迫提离职。",
    hrConcern: "招聘方可能了解离职前的实际工时、当前可接受的工作安排与岗位节奏是否匹配；不能据此判断抗压能力。",
    reframeAngle: "如实说明长期加班与身体负担，描述具体工作安排；可询问新岗位工时，不必承诺接受高强度加班。",
    quickScript:
      "前一份工作经常加班到凌晨，长时间的会议与临时问题处理给身体带来了较大负担，因此我选择离职。我想进一步了解这个岗位的日常工时、排期和紧急事项安排，确认双方对工作节奏的预期。",
    deepScript:
      "我离职的主要原因是前司长期加班到凌晨，会议和临时问题处理占用了很多时间，这种工作安排给身体带来了持续负担。希望这次能具体沟通日常排期、加班频率以及紧急任务的协调方式。我的时间安排与可接受范围是：[待补充：真实边界及仍需确认的条件]。涉及个人健康的细节，我希望只说明与岗位安排有关的部分。",
    forbidden: "不要编造大促攻坚经历、隐瞒影响岗位安排的必要条件或承诺无条件加班；可以如实说明工时边界与身体负担，避免人身攻击。",
  },
  {
    id: "pay-cut-delay",
    category: "resignation",
    title: "公司降薪 / 拖欠工资 / 福利断崖",
    badge: "经营风险合规",
    rawPain: "公司现金流暴雷，延发工资、强制打折，逼大家主动走人。",
    hrConcern: "招聘方可能核实薪资调整、发放情况和离职时间；薪资争议本身不能说明求职者冲动或缺乏理性。",
    reframeAngle: "说明实际发生的降薪或延发情况，不替公司推定经营原因，不以赞美目标公司财务状况代替核实。",
    quickScript:
      "前司出现了工资延发和降薪的情况，这是我考虑离开的主要原因。关于新的工作，我想先明确薪资结构、发放时间和书面约定，再结合岗位职责判断是否合适。",
    deepScript:
      "前司发生了工资延发与降薪，影响了原有的薪酬安排，因此我开始考虑新的工作机会。具体发生时间、调整幅度和目前离职进度是：[待补充：可以核实的实际情况]。我希望进一步了解这个岗位的职责、薪资构成与发放安排，依据明确的信息做决定。",
    forbidden: "不要补造受影响时长、家庭财务状况、交接成果或目标公司的财务声誉；可以如实说明欠薪事实和已确认的争议处理进度。",
  },
  {
    id: "career-ceiling",
    category: "resignation",
    title: "技术停滞 / 业务边缘化 / 触及天花板",
    badge: "说明发展诉求",
    rawPain: "天天维护祖传屎山代码，业务没有新增长点，干了两年感觉废了，学不到新东西。",
    hrConcern: "招聘方可能了解原有维护职责、实际工作内容与期望的发展方向；维护工作本身不是能力或积极性的负面证据。",
    reframeAngle: "客观说明两年的维护工作与发展诉求，不将日常维护改写成主导重构、性能治理或量化成果。",
    quickScript:
      "我在前司工作了两年，主要做既有系统维护，业务没有新增长点，感觉目前接触的新内容比较有限。接下来希望发展的方向是：[待补充：真实的学习或岗位目标]，也想了解这个岗位实际包含哪些工作。",
    deepScript:
      "过去两年，我的工作主要围绕既有系统维护展开。业务没有新增长点，我感觉工作中能接触的新内容比较有限。此前具体负责的内容是：[待补充：真实维护职责和工作实例]。我希望进一步沟通新岗位的维护、新开发与其他职责安排，判断是否符合自己的发展目标。",
    forbidden: "不要编造主导重构、故障率下降或技术巅峰状态；可以客观说明维护职责和发展需求，避免贬低维护工作或前团队。",
  },
  {
    id: "gap-recharge",
    category: "gap",
    title: "裸辞休息 / 调整身心状态",
    badge: "如实说明休整",
    rawPain: "上份工作连轴转了三年身心俱疲，裸辞后休息旅行了两个月，顺便学了点新框架，担心被当成懒散。",
    hrConcern: "招聘方可能了解空窗时间、当前求职安排与岗位所需技能；休息旅行本身不能说明散漫或能力下降。",
    reframeAngle: "保留休息旅行两个月及接触新框架的事实，不把零散学习扩写为系统课程或完整项目，也不推定已恢复最佳状态。",
    quickScript:
      "上一份工作连续三年强度比较大，离职后我休息、旅行了两个月，其间也接触了一些新框架。当前求职方向和可到岗安排是：[待补充：真实情况及仍需确认的事项]。",
    deepScript:
      "上一份工作连续三年强度较大，离职后这两个月主要用于休息和旅行，也学了一些新框架。具体接触的内容是：[待补充：框架名称和真实接触程度]。目前的求职方向、时间安排与到岗条件是：[待补充：真实情况]，也希望进一步了解这个岗位的日常职责。",
    forbidden: "不要为休息补造学习计划、项目 demo 或康复结论，也不必把休息说成成长成果；时间、学习程度与到岗条件应如实说明。",
  },
  {
    id: "gap-exam-retry",
    category: "gap",
    title: "考公 / 考研备战未上岸重回职场",
    badge: "澄清后续安排",
    rawPain: "毕业或离职后全职备考了一年，最后没考上，不得不重新找工作，怕被嫌弃心不定。",
    hrConcern: "招聘方可能了解当前求职方向、是否仍有考试安排及其与工作时间的关系；备考未通过不能说明缺乏投入。",
    reframeAngle: "如实说明一年全职备考及考试结果，后续是否再考按真实计划填写，不要求承诺永不再考或虚构心态转变。",
    quickScript:
      "过去一年我在全职备考，最终没有通过考试，目前重新求职。关于是否继续考试，以及它与工作时间的关系，我的实际安排是：[待补充：已确定的计划或尚未决定的事项]。",
    deepScript:
      "这一年的空窗主要用于全职备考，最终没有通过考试，现在我重新寻找工作。具体考试类别是：[待补充：真实类别]。目前希望应聘的方向是：[待补充：真实目标及相关经历]。后续是否继续考试、是否涉及工作时间调整，我的当前安排是：[待补充：已确定的计划及尚未决定的部分]。",
    forbidden: "不要将考公自动改成考研，或编造极强自律、抗压成长及永不再考的承诺；可以说明仍在考虑的考试计划与实际时间条件。",
  },
  {
    id: "gap-family-care",
    category: "gap",
    title: "照料家庭 / 个人健康休养",
    badge: "尊重隐私边界",
    rawPain: "因为家中有长辈生病或自己做了个手术需要休养调理，在家待了几个月。",
    hrConcern: "招聘方可能了解可到岗时间与必要的工作安排；具体疾病、家庭细节无需作为能力判断或必须披露的内容。",
    reframeAngle: "按实际选择家庭照护或个人休养，只说明愿意披露的岗位相关安排，不推定已康复、照护结束或可无条件投入。",
    quickScript:
      "这几个月主要用于[待补充：按实际选择家庭照护或个人休养]。与岗位有关的时间安排是：[待补充：可到岗时间、必要安排或仍待确认的事项]。更具体的健康和家庭细节，我希望保留隐私。",
    deepScript:
      "过去几个月，我因[待补充：家庭照护或个人休养的实际情况，仅说明愿意披露的部分]暂未工作。当前与到岗、出勤有关的条件是：[待补充：已确定的安排及仍需确认的事项]。如有后续安排需要协调，我会在涉及岗位要求时具体说明，也希望了解团队能够提供的安排。健康及家庭的其他细节，我希望保留隐私。",
    forbidden: "不要编造完全康复、家人可以自理、照护结束或无后顾之忧；可以保留隐私，也应如实沟通影响岗位安排的必要条件。",
  },
  {
    id: "gap-entrepreneurship",
    category: "gap",
    title: "创业折腾 / 自由职业 / 副业试错",
    badge: "区分经历与计划",
    rawPain: "和朋友一起搞独立开发或开工作室，结果搞了半年入不敷出失败了，重新回来打工。",
    hrConcern: "招聘方可能了解实际分工、当前是否仍有业务及其与新岗位的时间或利益关系；创业经历本身不能说明不服管理。",
    reframeAngle: "保留半年与朋友共同尝试、入不敷出及重新求职的事实；实际分工、经营原因和后续业务安排分别核实，不自动补成商业能力。",
    quickScript:
      "我和朋友共同做了半年的业务尝试，期间入不敷出，目前重新求职。我实际负责的是：[待补充：真实分工]。原业务是否继续、与新工作的时间关系是：[待补充：真实安排或待确认事项]。",
    deepScript:
      "过去半年，我和朋友一起尝试开展业务，最终没有实现收支平衡，现在重新寻找工作。业务的具体内容、我的分工和已知的经营情况是：[待补充：真实情况]。关于原业务当前状态、是否仍有合作以及与新岗位的时间或利益关系，我的安排是：[待补充：已知情况及尚未确定的部分]。",
    forbidden: "不要补造获客成本、全流程主导、商业能力提升或已彻底结束创业；如仍有合作或后续计划，按实际沟通时间安排与利益关系。",
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
      script: "话术未生成，请按已知事实补充。",
      keyPoints: [],
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

/** 清洗并验证 AI 生成的沟通参考报告 */
export function normalizeRemedyResult(raw: unknown): ResignationGapRemedyResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const title = typeof o.title === "string" ? o.title.trim().slice(0, 60) : "离职与空窗沟通参考";
  const punchline = typeof o.punchline === "string" ? o.punchline.trim().slice(0, 120) : "按已知事实准备表达；未提供的信息保留待补充。";

  // HR 心理分析
  const hrRaw = (o.hr_mindset_analysis && typeof o.hr_mindset_analysis === "object" ? o.hr_mindset_analysis : {}) as Record<string, unknown>;
  const hrMindsetAnalysis = {
    coreConcerns: strList(hrRaw.core_concerns, 5, 100),
    riskPoints: strList(hrRaw.risk_points, 5, 100),
    whatHrWantsToHear:
      typeof hrRaw.what_hr_wants_to_hear === "string"
        ? hrRaw.what_hr_wants_to_hear.trim().slice(0, 200)
        : "可补充与岗位相关的事实；招聘方的实际关注点无法仅凭当前材料确定。",
  };

  // 经历说明的四个要点
  const fRaw = (o.reframe_formula && typeof o.reframe_formula === "object" ? o.reframe_formula : {}) as Record<string, unknown>;
  const reframeFormula = {
    factAcknowledgment: typeof fRaw.fact_acknowledgment === "string" ? fRaw.fact_acknowledgment.trim().slice(0, 200) : "客观陈述事实，不粉饰不掩盖",
    positiveAttribution: typeof fRaw.positive_attribution === "string" ? fRaw.positive_attribution.trim().slice(0, 200) : "按已知信息客观说明原因；未说明时保留待补充",
    growthAndValue: typeof fRaw.growth_and_value === "string" ? fRaw.growth_and_value.trim().slice(0, 200) : "未提供相关行动或认识，需按真实情况补充或省略",
    motivationAlignment: typeof fRaw.motivation_alignment === "string" ? fRaw.motivation_alignment.trim().slice(0, 200) : "只衔接已提供的岗位目标；未说明时保留待补充",
  };

  // 三套话术
  const scriptsRaw = (o.scripts && typeof o.scripts === "object" ? o.scripts : {}) as Record<string, unknown>;
  const scripts = {
    concise: normalizeScript(scriptsRaw.concise, "精炼说明版（约 30 秒）"),
    detailed: normalizeScript(scriptsRaw.detailed, "详细说明版（约 1 分钟）"),
    pivoting: normalizeScript(scriptsRaw.pivoting, "岗位衔接版"),
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
        hrConcern: typeof drillObj.hr_concern === "string" ? drillObj.hr_concern.trim().slice(0, 150) : "招聘方的实际关注点无法仅凭当前材料确定",
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
    forbiddenList,
    closingTips,
  };
}

/** 新生成结果的上限；超限拒绝整份，避免截掉事实限定或待补充说明。 */
export const REMEDY_OUTPUT_LIMITS = {
  title: 60, punchline: 120, analysis: 200, formula: 200,
  label: 40, scene: 100, script: 800, listItem: 100,
  drillQuestion: 150, drillConcern: 150, drillResponse: 400,
  adviceItem: 120, listItems: 5, drills: 5, forbiddenItems: 8,
} as const;

function boundedText(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxChars && hasQuestionContent(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedTextList(value: unknown, maxItems: number, maxChars: number, minItems = 1): value is string[] {
  return Array.isArray(value) && value.length >= minItems && value.length <= maxItems &&
    value.every((item) => boundedText(item, maxChars));
}

/** 新结果完整通过校验后才转换；历史清洗逻辑不替新报告丢项或截断。 */
export function validateGeneratedRemedyResult(raw: unknown): ResignationGapRemedyResult | null {
  if (!record(raw) || !hasOnlyKeys(raw, [
    "title", "punchline", "hr_mindset_analysis", "reframe_formula", "scripts", "drills", "forbidden_list", "closing_tips",
  ])) return null;
  const limits = REMEDY_OUTPUT_LIMITS;
  if (!boundedText(raw.title, limits.title) || !boundedText(raw.punchline, limits.punchline)) return null;

  const mindset = raw.hr_mindset_analysis;
  if (!record(mindset) || !hasOnlyKeys(mindset, ["core_concerns", "risk_points", "what_hr_wants_to_hear"]) ||
    !boundedTextList(mindset.core_concerns, limits.listItems, limits.listItem, 0) ||
    !boundedTextList(mindset.risk_points, limits.listItems, limits.listItem, 0) ||
    !boundedText(mindset.what_hr_wants_to_hear, limits.analysis)) {
    return null;
  }
  const formula = raw.reframe_formula;
  if (
    !record(formula) || !hasOnlyKeys(formula, [
      "fact_acknowledgment", "positive_attribution", "growth_and_value", "motivation_alignment",
    ]) ||
    !boundedText(formula.fact_acknowledgment, limits.formula) ||
    !boundedText(formula.positive_attribution, limits.formula) ||
    !boundedText(formula.growth_and_value, limits.formula) ||
    !boundedText(formula.motivation_alignment, limits.formula)
  ) return null;

  const scripts = raw.scripts;
  if (!record(scripts) || !hasOnlyKeys(scripts, ["concise", "detailed", "pivoting"])) return null;
  for (const key of ["concise", "detailed", "pivoting"] as const) {
    const script = scripts[key];
    if (!record(script) || !hasOnlyKeys(script, ["label", "applicable_scene", "script", "key_points"]) ||
      !boundedText(script.label, limits.label) ||
      !boundedText(script.applicable_scene, limits.scene) || !boundedText(script.script, limits.script) ||
      !boundedTextList(script.key_points, limits.listItems, limits.listItem)) {
      return null;
    }
  }

  if (!Array.isArray(raw.drills) || raw.drills.length > limits.drills) return null;
  const drillQuestions = new Set<string>();
  for (const drill of raw.drills) {
    if (!record(drill) || !hasOnlyKeys(drill, ["question", "hr_concern", "best_response"]) ||
      !boundedText(drill.question, limits.drillQuestion) ||
      !boundedText(drill.hr_concern, limits.drillConcern) || !boundedText(drill.best_response, limits.drillResponse)) return null;
    const question = drill.question.trim();
    if (!hasQuestionContent(question)) return null;
    const questionKey = questionComparisonKey(question);
    if (!questionKey || drillQuestions.has(questionKey)) return null;
    drillQuestions.add(questionKey);
  }
  if (!boundedTextList(raw.forbidden_list, limits.forbiddenItems, limits.adviceItem, 0) ||
    !boundedTextList(raw.closing_tips, limits.listItems, limits.adviceItem)) return null;
  return normalizeRemedyResult(raw);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStoredScript(value: unknown): value is ScriptVersion {
  return record(value) && typeof value.label === "string" && typeof value.applicableScene === "string" &&
    typeof value.script === "string" && isStringList(value.keyPoints);
}

function isStoredRemedyResult(value: unknown): value is ResignationGapRemedyResult {
  if (!record(value) || typeof value.title !== "string" || typeof value.punchline !== "string") return false;
  const mindset = value.hrMindsetAnalysis;
  if (!record(mindset) || !isStringList(mindset.coreConcerns) || !isStringList(mindset.riskPoints) ||
    typeof mindset.whatHrWantsToHear !== "string") return false;
  const formula = value.reframeFormula;
  if (!record(formula) || !["factAcknowledgment", "positiveAttribution", "growthAndValue", "motivationAlignment"]
    .every((key) => typeof formula[key] === "string")) return false;
  const scripts = value.scripts;
  if (!record(scripts) || !isStoredScript(scripts.concise) || !isStoredScript(scripts.detailed) ||
    !isStoredScript(scripts.pivoting)) return false;
  if (![scripts.concise, scripts.detailed, scripts.pivoting].some((script) => script.script.trim())) return false;
  if (!Array.isArray(value.drills) || !value.drills.every((drill) => record(drill) &&
    typeof drill.question === "string" && typeof drill.hrConcern === "string" && typeof drill.bestResponse === "string")) return false;
  return isStringList(value.forbiddenList) && isStringList(value.closingTips);
}

/**
 * 历史报告按实际展示字段校验，损坏结构返回 null 供页面展示恢复入口。
 * 不套用新生成结果的篇幅上限，不截断旧话术，也不以默认建议补造缺失材料。
 */
export function parseRemedyResult(json: string): ResignationGapRemedyResult | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isStoredRemedyResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
