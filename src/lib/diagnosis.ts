import { normalizeScores, validateGeneratedScores, type ScoreMap } from "./scores";
import type { ModuleData } from "./modules";
import { escapePlainTextToRichHtml, stripRichText } from "./rich-text";
import { hasQuestionContent } from "./question-normalization";

/** 允许 AI 给出改写建议的字段白名单 */
export type DiagnosisField = "description" | "text" | "items";

export type DiagnosisSuggestion = {
  /** 列表模块的条目 id；模块级字段（summary.text / skills.items）为空串 */
  itemId: string;
  field: DiagnosisField;
  /** 为什么要改（对应 JD 的哪条要求） */
  reason: string;
  /** 改写草稿：description/text 为整段替换文本，items 为覆盖全部技能的数组 */
  draft: string | string[];
};

export type ModuleDiagnosis = {
  moduleKey: string;
  label: string;
  scores: ScoreMap;
  /** 该模块与岗位要求的差距说明 */
  gaps: string;
  suggestions: DiagnosisSuggestion[];
};

export type DiagnosisReport = {
  /** 新报告的模型文本（总评、差距、理由和草稿）均为纯文本。 */
  textFormat?: "plain-text";
  /** 兼容旧报告中仅标记草稿为纯文本的格式。 */
  draftFormat?: "plain-text";
  /** 总体岗位匹配度 0-10 */
  match: number;
  summary: string;
  modules: ModuleDiagnosis[];
};

/** 将模型纯文本转为编辑器格式；技能与历史富文本保留原值，手动编辑值不经过此转换。 */
export function diagnosisDraftForEditor(report: DiagnosisReport | null | undefined, suggestion: DiagnosisSuggestion): string | string[] {
  const plainText = report?.textFormat === "plain-text" || report?.draftFormat === "plain-text";
  return suggestion.field !== "items" && typeof suggestion.draft === "string" && plainText
    ? escapePlainTextToRichHtml(suggestion.draft)
    : suggestion.draft;
}

/** 新生成诊断的篇幅与数量上限；历史报告读取继续使用宽松兼容校验。 */
export const DIAGNOSIS_OUTPUT_LIMITS = {
  summary: 500,
  gaps: 500,
  reason: 300,
  textDraft: 1_800,
  descriptionDraft: 2_400,
  skill: 100,
  maxSkills: 100,
  totalText: 30_000,
} as const;

export type DiagnosisSnapshot = { title: string; modules: ModuleData[] };
export type DiagnosisAdoption = {
  moduleKey: string;
  suggestionIndex: number;
  value: string | string[];
  applied_at: string;
};
export type DiagnosisRecord = {
  /** 读取失败的存储字段；对应占位值不可用于采纳或快照比较。原数据库保留不变。 */
  corruptedFields?: ("report" | "resume_snapshot" | "adoptions")[];
  /** 完整读取保留损坏字段及因此被隐藏的报告原稿；默认网页展示不附带。 */
  raw_fields?: Partial<Record<"report" | "resume_snapshot" | "adoptions", string>>;
  id: number;
  resume_version_id?: number | null;
  job_id: string;
  job_title: string;
  jd: string;
  report: DiagnosisReport | null;
  resume_snapshot: DiagnosisSnapshot;
  adoptions: DiagnosisAdoption[];
  created_at: string;
};
export type DiagnosisHistoryItem = Pick<DiagnosisRecord, "id" | "job_id" | "job_title" | "created_at"> & { match: number | null };
export type DiagnosisHistoryResponse = {
  current: DiagnosisRecord | null;
  previous: DiagnosisRecord | null;
  history: DiagnosisHistoryItem[];
};

/** 技能历史可能使用换行字符串；仅统一容器，保留顺序、重复项及所有字面字符。 */
export function diagnosisValuesEqual(field: DiagnosisField, left: string | string[] | null, right: string | string[] | null): boolean {
  const comparable = (value: string | string[] | null) => field === "items" && typeof value === "string"
    ? value.split(/\r\n?|\n/) : value;
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

/** 精确读取唯一目标字段；目标缺失或重复时返回 null，不猜测建议属于哪一条经历。 */
export function diagnosisValue(modules: ModuleData[], moduleKey: string, suggestion: DiagnosisSuggestion): string | string[] | null {
  const matchingModules = modules.filter((entry) => entry.key === moduleKey);
  if (matchingModules.length !== 1) return null;
  const mod = matchingModules[0]!;
  if (suggestion.field === "description") {
    if (!["work", "projects", "education"].includes(mod.type) || !Array.isArray(mod.content)) return null;
    const matchingItems = (mod.content as { id: string; description?: string; descriptionItems?: string[] }[]).filter((it) => it?.id === suggestion.itemId);
    if (!suggestion.itemId || matchingItems.length !== 1) return null;
    const item = matchingItems[0]!;
    if (item.description !== undefined && item.description !== null && item.description !== "") {
      return item.description;
    }
    if (Array.isArray(item.descriptionItems) && item.descriptionItems.length > 0) {
      return item.descriptionItems.join("\n");
    }
    return item.description ?? null;
  }
  if (suggestion.field === "text" && mod.type === "summary" && suggestion.itemId === "") return (mod.content as { text: string }).text;
  if (suggestion.field === "items" && mod.type === "skills" && suggestion.itemId === "") return (mod.content as { items: string[] }).items;
  return null;
}

const FIELDS: readonly DiagnosisField[] = ["description", "text", "items"];

function isDiagnosisField(value: unknown): value is DiagnosisField {
  return typeof value === "string" && (FIELDS as readonly string[]).includes(value);
}

/** 清洗一条改写建议：目标模块/条目/字段类型不合法时返回 null（丢弃该条） */
function normalizeSuggestion(raw: unknown, mod: ModuleData): DiagnosisSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!isDiagnosisField(o.field)) return null;
  const field = o.field;
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  const itemId = typeof o.item_id === "string" ? o.item_id : "";

  if (field === "description") {
    if (!["education", "work", "projects"].includes(mod.type)) return null;
    const items = Array.isArray(mod.content) ? (mod.content as { id?: string }[]) : [];
    if (!itemId || items.filter((it) => it && typeof it === "object" && it.id === itemId).length !== 1) return null;
    const draft = typeof o.draft === "string" ? o.draft.trim() : "";
    if (!draft) return null;
    return { itemId, field, reason, draft };
  }
  if (field === "text") {
    if (mod.type !== "summary" || itemId) return null;
    const draft = typeof o.draft === "string" ? o.draft.trim() : "";
    if (!draft) return null;
    return { itemId: "", field, reason, draft };
  }
  // items：技能整组替换
  if (mod.type !== "skills" || itemId) return null;
  const draft = Array.isArray(o.draft)
    ? o.draft.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  if (draft.length === 0) return null;
  return { itemId: "", field, reason, draft };
}

/** 清洗诊断报告：模块不存在或评分非法的条目丢弃，建议逐条校验；整体无效返回 null */
export function normalizeDiagnosis(raw: unknown, modules: ModuleData[]): DiagnosisReport | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const match = o.match;
  if (typeof match !== "number" || !Number.isFinite(match) || match < 0 || match > 10) return null;
  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  if (!Array.isArray(o.modules) || o.modules.length === 0) return null;

  const result: ModuleDiagnosis[] = [];
  const seen = new Set<string>();
  for (const m of o.modules) {
    if (!m || typeof m !== "object") continue;
    const mo = m as Record<string, unknown>;
    const moduleKey = typeof mo.module_key === "string" ? mo.module_key : "";
    if (!moduleKey || seen.has(moduleKey)) continue;
    const mod = modules.find((x) => x.key === moduleKey);
    if (!mod) continue;
    const scores = normalizeScores(mo.scores);
    if (!scores) continue;
    seen.add(moduleKey);
    const suggestions = Array.isArray(mo.suggestions)
      ? mo.suggestions
          .map((s) => normalizeSuggestion(s, mod))
          .filter((s): s is DiagnosisSuggestion => s !== null)
      : [];
    result.push({
      moduleKey,
      label: mod.label,
      scores,
      gaps: typeof mo.gaps === "string" ? mo.gaps.trim() : "",
      suggestions,
    });
  }
  // 提示词要求每个职业内容模块都有评分；不保存只评了部分简历的“总体匹配度”。
  if (result.length === 0 || result.length !== new Set(modules.map((module) => module.key)).size) return null;
  return { match: Math.round(match * 10) / 10, summary, modules: result };
}

/** 新生成报告必须完整有效；历史清洗仍使用 normalizeDiagnosis。 */
export function validateGeneratedDiagnosis(raw: unknown, modules: ModuleData[]): DiagnosisReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  if (!exactKeys(source, ["match", "summary", "modules"])) return null;
  const limits = DIAGNOSIS_OUTPUT_LIMITS;
  const boundedText = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= max && hasQuestionContent(value);
  const optionalText = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.trim().length <= max && (!value.trim() || hasQuestionContent(value));
  if (typeof source.match !== "number" || !Number.isFinite(source.match) || source.match < 0 || source.match > 10
    || !Number.isInteger(source.match * 10)
    || !boundedText(source.summary, limits.summary)
    || !Array.isArray(source.modules) || source.modules.length !== modules.length) return null;
  let totalText = source.summary.trim().length;
  const seenModules = new Set<string>();
  for (const entry of source.modules) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (!exactKeys(row, ["module_key", "scores", "gaps", "suggestions"])) return null;
    if (!row.scores || typeof row.scores !== "object" || Array.isArray(row.scores) ||
        !exactKeys(row.scores as Record<string, unknown>, ["depth", "structure", "authenticity", "completeness"])) return null;
    if (typeof row.module_key !== "string" || seenModules.has(row.module_key)) return null;
    const mod = modules.find((item) => item.key === row.module_key);
    const scores = validateGeneratedScores(row.scores);
    if (!mod || !scores || Object.values(scores).some((score) => score < 1)
      || !optionalText(row.gaps, limits.gaps) || !Array.isArray(row.suggestions)) return null;
    totalText += (row.gaps as string).trim().length;
    seenModules.add(row.module_key);
    const targets = new Set<string>();
    for (const suggestion of row.suggestions) {
      if (!suggestion || typeof suggestion !== "object" || Array.isArray(suggestion)) return null;
      const item = suggestion as Record<string, unknown>;
      if (!exactKeys(item, ["item_id", "field", "reason", "draft"])) return null;
      if (typeof item.item_id !== "string" || !boundedText(item.reason, limits.reason)) return null;
      // 技能是整组替换，不得过滤掉错误元素后把残缺列表交给采纳流程。
      if (item.field === "items") {
        if (!Array.isArray(item.draft) || item.draft.length === 0 || item.draft.length > limits.maxSkills
          || !item.draft.every((skill) => boundedText(skill, limits.skill))) return null;
        totalText += item.draft.reduce((sum, skill) => sum + skill.trim().length, 0);
      } else {
        const maxDraft = item.field === "description" ? limits.descriptionDraft : limits.textDraft;
        if (!boundedText(item.draft, maxDraft)) return null;
        totalText += item.draft.trim().length;
      }
      totalText += (item.reason as string).trim().length;
      if (totalText > limits.totalText) return null;
      const normalized = normalizeSuggestion(item, mod);
      if (!normalized) return null;
      const target = JSON.stringify([normalized.itemId, normalized.field]);
      if (targets.has(target)) return null;
      targets.add(target);
    }
  }
  if (totalText > limits.totalText) return null;
  const report = normalizeDiagnosis(raw, modules);
  return report ? { ...report, textFormat: "plain-text" } : null;
}

/**
 * 为 LLM 诊断准备模块数据：保留模块与条目结构（key/id/label 等），
 * 仅将正文富文本（description/descriptionItems、summary.text）转换为纯文本，保留分条边界。
 * 技能、副项和抬头本来就是纯文本，不能解析其中的泛型、标签或实体字面量。
 */
export function sanitizeModulesForDiagnosis(modules: ModuleData[]): ModuleData[] {
  return modules.map((m) => {
    if (m.type === "summary") {
      const content = m.content as { text?: string; descriptionItems?: string[] };
      const text = content?.text ?? "";
      return { ...m, content: { text: stripRichText(text),
        ...(Array.isArray(content?.descriptionItems) && content.descriptionItems.length
          ? { descriptionItems: content.descriptionItems.map(stripRichText) } : {}),
      } };
    }
    if (Array.isArray(m.content)) {
      const sanitizedContent = (m.content as Record<string, unknown>[]).map((item) => {
        const next = { ...item };
        if (typeof next.description === "string") {
          next.description = stripRichText(next.description);
        }
        if (Array.isArray(next.descriptionItems)) {
          next.descriptionItems = next.descriptionItems.map((d) => (typeof d === "string" ? stripRichText(d) : d));
        }
        return next;
      });
      return { ...m, content: sanitizedContent };
    }
    return m;
  });
}

