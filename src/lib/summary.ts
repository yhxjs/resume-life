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

/** 模型输出校验：必须包含有效的五维或简历三要素内容 */
export function isGeneratedProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;

  const hasValidFive = SUMMARY_SECTIONS.some(
    ({ key }) => typeof fields[key] === "string" && (fields[key] as string).trim().length > 0
  );

  const hasValidResume =
    (typeof fields.techStack === "string" && fields.techStack.trim().length > 0) ||
    (typeof fields.brief === "string" && fields.brief.trim().length > 0) ||
    (Array.isArray(fields.achievements) &&
      fields.achievements.some((a) => typeof a === "string" && a.trim().length > 0));

  return hasValidFive || hasValidResume;
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
