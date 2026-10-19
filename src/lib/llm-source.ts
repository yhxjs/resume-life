/**
 * LLM 调用的来源描述。放在叶子模块（不 import 任何项目内模块），
 * 因为它同时被 llm-call-log.ts 与 llm.ts 需要；若定义在 safe-llm.ts 会形成
 * safe-llm → llm → llm-call-log → safe-llm 的循环导入。
 */

/** 功能名清单。逐项内容以设计文档「功能名清单」表为唯一依据。 */
export const LLM_FEATURES = {
  settingsConnectionTest: "模型连接测试",
  resumePolish: "简历润色",
  resumeDiagnose: "简历诊断",
  resumeImportParse: "简历导入解析",
  projectSummarize: "项目材料总结",
  projectRepoRelation: "代码库关联研判",
  styleGenerate: "样式 AI 调优",
  drillProject: "项目深挖出题",
  drillBank: "岗位题库出题",
  drillRemediation: "错题补救出题",
  realInterviewReview: "真实面试逐题复盘",
  drillGrade: "练习作答评分",
  interviewCreate: "模拟面试出题",
  interviewEvaluatorReport: "面试官评估报表",
  interviewFinish: "面试总结报告",
  interviewReverse: "面试反问环节",
  interviewReference: "参考答案生成",
  interviewRetryGrade: "作答重评",
  introGenerate: "自我介绍生成",
  introRecomment: "自我介绍重新建议",
  introRegenerate: "自我介绍重新生成",
  gapRemedyGenerate: "空窗期对策生成",
  jargonDecode: "黑话解码",
  jdPortraitGenerate: "JD 画像生成",
  defenseScan: "简历排雷扫描",
  defenseDrillGrade: "防御演练评分",
  negotiationStart: "薪资谈判开局",
  negotiationFinalize: "薪资谈判总结",
  negotiationTurn: "薪资谈判追问",
  seriesAdvance: "连打推进出题",
  seriesAnswerGrade: "连打作答评分",
  seriesFinalize: "连打总结报告",
} as const;

export type LlmFeature = (typeof LLM_FEATURES)[keyof typeof LLM_FEATURES];

export const ENTITY_TYPES = [
  "resume",
  "interview",
  "interview_series",
  "project",
  "intro",
  "drill",
  "bank_entry",
  "defense",
  "negotiation",
  "jd_portrait",
  "jargon_decoding",
  "gap_remedy",
  "template",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type LlmSource = {
  feature: LlmFeature;
  entity?: { type: EntityType; id: number };
};

/** token 用量。null = 上游未上报，与 0 严格区分。 */
export type LlmUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
};

export const EMPTY_USAGE: LlmUsage = { inputTokens: null, outputTokens: null, cachedTokens: null };

/** 流式场景下 usage 会分多次到达（如 Anthropic 的 message_start + message_delta），逐个合并 */
export function mergeUsage(base: LlmUsage, delta: Partial<LlmUsage>): LlmUsage {
  return {
    inputTokens: delta.inputTokens ?? base.inputTokens,
    outputTokens: delta.outputTokens ?? base.outputTokens,
    cachedTokens: delta.cachedTokens ?? base.cachedTokens,
  };
}
