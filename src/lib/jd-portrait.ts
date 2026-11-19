/** JD 考点画像的领域类型与 AI 输出规整（工具箱首个工具，见 CONTEXT.md） */
import { hasQuestionContent, questionComparisonKey, textComparisonKey } from "./question-normalization";

export type JdMustSkill = {
  /** 考点/技能名，保留技术名称原意 */
  name: string;
  /** 准备优先级 1-10，不代表真实必考概率 */
  weight: number;
  /** 判断依据（JD 中的哪条要求支撑这个判断） */
  why: string;
};

export type JdFollowup = {
  /** 追问方向/话题 */
  topic: string;
  /** 该方向下建议练习的具体问题 */
  questions: string[];
};

export type JdCompanyStyle = {
  /** 公司/团队风格猜测（一句话） */
  style: string;
  /** 从 JD 中读出的推断信号 */
  signals: string[];
};

export type JdPortraitResult = {
  /** 岗位速写：一句话概括方向/级别/技术栈 */
  role: string;
  mustSkills: JdMustSkill[];
  followups: JdFollowup[];
  companyStyle: JdCompanyStyle;
};

const MAX_SKILLS = 8;
const MAX_FOLLOWUPS = 6;
const MAX_QUESTIONS = 5;
const MAX_SIGNALS = 5;

/** 新生成画像的保存上限；校验失败时不得通过截断或丢项修复。 */
export const JD_PORTRAIT_OUTPUT_LIMITS = {
  role: 30, skillName: 80, skillWhy: 120, topic: 40, question: 120,
  companyStyle: 80, signal: 120,
  skills: 8, followups: 6, questions: 5, signals: 4,
} as const;

/** 不为缺失的权重补造中间分，也不将百分比猜测为优先级。 */
function normalizeWeight(raw: unknown): number | null {
  if (typeof raw !== "number" && (typeof raw !== "string" || !raw.trim())) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

function strList(raw: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, max);
}

/** 历史兼容清洗；新生成结果使用 validateGeneratedJdPortrait，避免丢项或截断。 */
export function normalizeJdPortrait(raw: unknown): JdPortraitResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const role = typeof o.role === "string" ? o.role.trim().slice(0, 60) : "";
  if (!role || !Array.isArray(o.must_skills) || !Array.isArray(o.followups)) return null;

  const skills: JdMustSkill[] = [];
  const skillNames = new Set<string>();
  if (Array.isArray(o.must_skills)) {
    for (const item of o.must_skills.slice(0, MAX_SKILLS)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const s = item as Record<string, unknown>;
      const name = typeof s.name === "string" ? s.name.trim().slice(0, 20) : "";
      const weight = normalizeWeight(s.weight);
      if (!name || weight === null) return null;
      const nameKey = name.toLowerCase();
      if (skillNames.has(nameKey)) continue;
      skillNames.add(nameKey);
      skills.push({
        name,
        weight,
        why: typeof s.why === "string" ? s.why.trim().slice(0, 120) : "",
      });
    }
  }
  // 少于三个技能仍保留真实信息，页面只展示列表，不为雷达凑轴。
  skills.sort((a, b) => b.weight - a.weight);

  const followups: JdFollowup[] = [];
  if (Array.isArray(o.followups)) {
    for (const item of o.followups.slice(0, MAX_FOLLOWUPS)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const f = item as Record<string, unknown>;
      const topic = typeof f.topic === "string" ? f.topic.trim().slice(0, 40) : "";
      if (!topic || !Array.isArray(f.questions)) return null;
      const questions = strList(f.questions, MAX_QUESTIONS, 120);
      if (!questions.length) return null;
      followups.push({ topic, questions });
    }
  }

  const styleRaw = o.company_style;
  let companyStyle: JdCompanyStyle | null = null;
  if (styleRaw && typeof styleRaw === "object" && !Array.isArray(styleRaw)) {
    const c = styleRaw as Record<string, unknown>;
    const style = typeof c.style === "string" ? c.style.trim().slice(0, 80) : "";
    if (style && Array.isArray(c.signals)) companyStyle = { style, signals: strList(c.signals, MAX_SIGNALS, 120) };
  }
  if (!companyStyle) return null;

  return { role, mustSkills: skills, followups, companyStyle };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && hasQuestionContent(value) && value.trim().length <= maxChars;
}

function boundedTexts(
  value: unknown,
  maxItems: number,
  maxChars: number,
  minItems = 0,
  comparisonKey: (text: string) => string = textComparisonKey,
): value is string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems ||
      !value.every((item) => boundedText(item, maxChars))) return false;
  const keys = value.map((item: string) => comparisonKey(item));
  return keys.every(Boolean) && new Set(keys).size === value.length;
}

/** 整份通过后只去首尾空白、排序和映射字段，保留全部条目与句尾限定。 */
export function validateGeneratedJdPortrait(raw: unknown): JdPortraitResult | null {
  const limits = JD_PORTRAIT_OUTPUT_LIMITS;
  const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(value).every((key) => allowed.includes(key));
  if (!record(raw) || !hasOnlyKeys(raw, ["role", "must_skills", "followups", "company_style"]) || !boundedText(raw.role, limits.role) ||
      !Array.isArray(raw.must_skills) || raw.must_skills.length > limits.skills ||
      !Array.isArray(raw.followups) || raw.followups.length > limits.followups ||
      !record(raw.company_style) || !hasOnlyKeys(raw.company_style, ["style", "signals"]) || !boundedText(raw.company_style.style, limits.companyStyle) ||
      !boundedTexts(raw.company_style.signals, limits.signals, limits.signal)) return null;

  const skills: JdMustSkill[] = [];
  const skillNames = new Set<string>();
  for (const item of raw.must_skills) {
    if (!record(item) || !hasOnlyKeys(item, ["name", "weight", "why"]) || !boundedText(item.name, limits.skillName) || !boundedText(item.why, limits.skillWhy) ||
        typeof item.weight !== "number" || !Number.isInteger(item.weight) || item.weight < 1 || item.weight > 10) return null;
    const name = item.name.trim();
    const nameKey = textComparisonKey(name);
    if (skillNames.has(nameKey)) return null;
    skillNames.add(nameKey);
    skills.push({ name, weight: item.weight, why: item.why.trim() });
  }

  const followups: JdFollowup[] = [];
  const topics = new Set<string>();
  const questions = new Set<string>();
  for (const item of raw.followups) {
    if (!record(item) || !hasOnlyKeys(item, ["topic", "questions"]) || !boundedText(item.topic, limits.topic) ||
        !boundedTexts(item.questions, limits.questions, limits.question, 1, questionComparisonKey)) return null;
    const topic = item.topic.trim();
    const topicKey = textComparisonKey(topic);
    if (topics.has(topicKey)) return null;
    topics.add(topicKey);
    for (const question of item.questions) {
      if (!hasQuestionContent(question)) return null;
      const key = questionComparisonKey(question);
      if (questions.has(key)) return null;
      questions.add(key);
    }
    followups.push({ topic, questions: item.questions.map((question) => question.trim()) });
  }

  return {
    role: raw.role.trim(),
    mustSkills: skills.sort((a, b) => b.weight - a.weight),
    followups,
    companyStyle: { style: raw.company_style.style.trim(), signals: raw.company_style.signals.map((signal) => signal.trim()) },
  };
}

function storedTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 校验历史展示所需结构；不截断文本、不删条目，也不套用新生成的数量上限。 */
export function parseJdPortraitResult(json: string): JdPortraitResult | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!record(parsed) || typeof parsed.role !== "string" || !Array.isArray(parsed.mustSkills) ||
      !parsed.mustSkills.every((skill) => record(skill) && typeof skill.name === "string" &&
        typeof skill.why === "string" && typeof skill.weight === "number" &&
        Number.isInteger(skill.weight) && skill.weight >= 1 && skill.weight <= 10) ||
      !Array.isArray(parsed.followups) || !parsed.followups.every((followup) => record(followup) &&
        typeof followup.topic === "string" && storedTextList(followup.questions)) ||
      !record(parsed.companyStyle) || typeof parsed.companyStyle.style !== "string" ||
      !storedTextList(parsed.companyStyle.signals)) return null;
    return parsed as JdPortraitResult;
  } catch {
    return null;
  }
}
