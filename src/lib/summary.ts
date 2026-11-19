import { hasQuestionContent, textComparisonKey } from "./question-normalization";

export type FiveDimensionSummaryKey =
  | "overview"
  | "architecture"
  | "highlights"
  | "responsibilities"
  | "challenges";

export type ProjectSummary = {
  overview: string;
  architecture: string;
  highlights: string;
  responsibilities: string;
  challenges: string;

  techStack: string;
  brief: string;
  achievements: string[];
};

/** 新生成总结的上限；旧档案和手动编辑继续无损处理。 */
export const PROJECT_SUMMARY_OUTPUT_LIMITS = {
  dimension: 1_000,
  techStack: 200,
  brief: 200,
  achievement: 300,
  maxAchievements: 10,
  totalText: 8_000,
} as const;

export const SUMMARY_SECTIONS: { key: FiveDimensionSummaryKey; label: string }[] = [
  { key: "overview", label: "项目概述" },
  { key: "architecture", label: "架构设计" },
  { key: "highlights", label: "技术亮点" },
  { key: "responsibilities", label: "主要职责" },
  { key: "challenges", label: "难点与成果" },
];

export const RESUME_SUMMARY_LABELS = {
  techStack: "技术栈",
  brief: "项目简要概述",
  achievements: "项目描述与成果",
} as const;

export function emptySummary(): ProjectSummary {
  return {
    overview: "",
    architecture: "",
    highlights: "",
    responsibilities: "",
    challenges: "",
    techStack: "",
    brief: "",
    achievements: [],
  };
}

/** 已解析档案是否包含可供提炼的文字；空白字段和空白成果不构成来源。 */
export function hasProjectSummaryContent(summary: ProjectSummary | null | undefined): boolean {
  return !!summary && Object.values(summary).some((value) =>
    typeof value === "string" ? value.trim().length > 0 : value.some((text) => text.trim().length > 0)
  );
}

const VALID_SUMMARY_KEYS = new Set([
  "overview",
  "architecture",
  "highlights",
  "responsibilities",
  "challenges",
  "techStack",
  "brief",
  "achievements",
]);

const GENERATED_RESUME_KEYS = new Set(["techStack", "brief", "achievements"]);

export interface GeneratedProjectSummaryIssue { kind: "format" | "length"; message: string }
function summaryIssue(message: string, kind: GeneratedProjectSummaryIssue["kind"] = "format"): GeneratedProjectSummaryIssue {
  return { kind, message };
}

/** 只检查新生成成果；理由不回显原文，比较格式差异而不改写或自动合并。 */
function generatedAchievementsIssue(value: unknown): GeneratedProjectSummaryIssue | null {
  if (!Array.isArray(value)) return summaryIssue("achievements 必须是字符串数组");
  if (value.length > PROJECT_SUMMARY_OUTPUT_LIMITS.maxAchievements) return summaryIssue(`achievements 有 ${value.length} 条，最多允许 ${PROJECT_SUMMARY_OUTPUT_LIMITS.maxAchievements} 条`, "length");
  const seen = new Map<string, number>();
  for (const [index, item] of value.entries()) {
    const label = `achievements 第 ${index + 1} 条`;
    if (typeof item !== "string") return summaryIssue(`${label} 必须是字符串`);
    if (!item.trim() || !hasQuestionContent(item)) return summaryIssue(`${label} 没有有效文字`);
    if (item.length > PROJECT_SUMMARY_OUTPUT_LIMITS.achievement) return summaryIssue(`${label} 长度 ${item.length}，超过 ${PROJECT_SUMMARY_OUTPUT_LIMITS.achievement} 字上限`, "length");
    const key = textComparisonKey(item);
    if (seen.has(key)) return summaryIssue(`${label} 与第 ${seen.get(key)! + 1} 条重复（忽略全半角、大小写与空白差异）`);
    seen.set(key, index);
  }
  return null;
}

function validGeneratedAchievements(value: unknown): value is string[] {
  return generatedAchievementsIssue(value) === null;
}

export function isStoredProjectSummary(value: unknown): value is ProjectSummary | Record<string, never> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0) return true;
  return entries.length === VALID_SUMMARY_KEYS.size && entries.every(([key, field]) => {
    if (!VALID_SUMMARY_KEYS.has(key)) return false;
    if (key === "achievements") {
      return Array.isArray(field) && field.every((item) => typeof item === "string");
    }
    return typeof field === "string";
  });
}

/** 完整生成的校验理由；只返回固定字段名、位置与长度，不暴露模型原文。 */
export function getGeneratedProjectSummaryIssue(value: unknown): GeneratedProjectSummaryIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return summaryIssue("顶层必须是 JSON 对象");
  const fields = value as Record<string, unknown>;
  const missing = [...VALID_SUMMARY_KEYS].filter(key => !Object.hasOwn(fields, key));
  if (missing.length) return summaryIssue(`缺少字段：${missing.join("、")}`);
  const extraCount = Object.keys(fields).filter(key => !VALID_SUMMARY_KEYS.has(key)).length;
  if (extraCount) return summaryIssue(`包含 ${extraCount} 个额外字段，只允许指定八字段`);
  const textKeys = [...SUMMARY_SECTIONS.map(({ key }) => key), "techStack", "brief"] as const;
  for (const key of textKeys) {
    const field = fields[key];
    if (typeof field !== "string") return summaryIssue(`${key} 必须是字符串`);
    if (field.trim() && !hasQuestionContent(field)) return summaryIssue(`${key} 没有有效文字`);
    const limit = key === "techStack" ? PROJECT_SUMMARY_OUTPUT_LIMITS.techStack
      : key === "brief" ? PROJECT_SUMMARY_OUTPUT_LIMITS.brief : PROJECT_SUMMARY_OUTPUT_LIMITS.dimension;
    if (field.length > limit) return summaryIssue(`${key} 长度 ${field.length}，超过 ${limit} 字上限`, "length");
  }
  const achievementsIssue = generatedAchievementsIssue(fields.achievements);
  if (achievementsIssue) return achievementsIssue;
  const stringFields = textKeys.map(key => fields[key] as string);
  const achievements = fields.achievements as string[];
  const totalText = [...stringFields, ...achievements].reduce((total, field) => total + field.trim().length, 0);
  if (totalText > PROJECT_SUMMARY_OUTPUT_LIMITS.totalText) return summaryIssue(`文本总量 ${totalText}，超过 ${PROJECT_SUMMARY_OUTPUT_LIMITS.totalText} 字上限`, "length");
  return stringFields.some((field) => field.trim().length > 0) || achievements.length > 0 ? null : summaryIssue("源码材料没有可归纳的可靠项目信息");
}

export function getGeneratedProjectSummaryError(value: unknown): string | null {
  return getGeneratedProjectSummaryIssue(value)?.message ?? null;
}

/** 未知事实可明确留空，残缺输出不能清洗成成功草稿。 */
export function isGeneratedProjectSummary(value: unknown): value is ProjectSummary {
  return getGeneratedProjectSummaryError(value) === null;
}

/** 模型按提示返回完整空结构时，这是无有效内容的信号，不是可采纳总结。 */
export function isEmptyGeneratedProjectSummary(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== VALID_SUMMARY_KEYS.size || Object.keys(fields).some((key) => !VALID_SUMMARY_KEYS.has(key))) return false;
  const textFields = [...SUMMARY_SECTIONS.map(({ key }) => fields[key]), fields.techStack, fields.brief];
  return textFields.every((field) => typeof field === "string" && !field.trim()) &&
    Array.isArray(fields.achievements) && fields.achievements.length === 0;
}

/** 简历提炼必须完整返回三要素；明确的空值可用于移除没有依据的旧内容。 */
export function validateGeneratedProjectResume(value: unknown): Pick<ProjectSummary, "techStack" | "brief" | "achievements"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== GENERATED_RESUME_KEYS.size || Object.keys(fields).some((key) => !GENERATED_RESUME_KEYS.has(key))) return null;
  if (typeof fields.techStack !== "string" || typeof fields.brief !== "string" || !validGeneratedAchievements(fields.achievements) ||
      (fields.techStack.trim() !== "" && !hasQuestionContent(fields.techStack)) ||
      (fields.brief.trim() !== "" && !hasQuestionContent(fields.brief)) ||
      fields.techStack.length > PROJECT_SUMMARY_OUTPUT_LIMITS.techStack ||
      fields.brief.length > PROJECT_SUMMARY_OUTPUT_LIMITS.brief) return null;
  const totalText = fields.techStack.trim().length + fields.brief.trim().length +
    fields.achievements.reduce((total, item) => total + (item as string).trim().length, 0);
  if (totalText > PROJECT_SUMMARY_OUTPUT_LIMITS.totalText) return null;
  return { techStack: fields.techStack.trim(), brief: fields.brief.trim(), achievements: fields.achievements.map((item) => item.trim()) };
}

export class ProjectSummaryCorruptError extends Error {
  constructor() {
    super("项目总结数据损坏，请修复项目档案或恢复有效备份");
    this.name = "ProjectSummaryCorruptError";
  }
}

export function parseSummary(raw: string): ProjectSummary {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProjectSummaryCorruptError();
  }
  if (!isStoredProjectSummary(value)) throw new ProjectSummaryCorruptError();
  if (Object.keys(value).length === 0) return emptySummary();
  const summary = value as ProjectSummary;
  return { ...summary, achievements: [...summary.achievements] };
}

/** 逐字段清洗总结对象：非字符串/非数组字段一律置空，落库前统一走这里 */
export function normalizeSummary(raw: unknown): ProjectSummary {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const result = emptySummary();

  for (const s of SUMMARY_SECTIONS) {
    const v = o[s.key];
    if (typeof v === "string") result[s.key] = v;
  }

  if (typeof o.techStack === "string") result.techStack = o.techStack;
  if (typeof o.brief === "string") result.brief = o.brief;

  if (Array.isArray(o.achievements)) {
    result.achievements = o.achievements
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
  } else if (typeof o.achievements === "string") {
    // 兼容模型偶现返回换行文本的情况
    result.achievements = o.achievements
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\d.]+\s*/, "").trim())
      .filter((l) => l.length > 0);
  }

  return result;
}
