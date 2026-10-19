import { normalizeScores, type ScoreMap } from "./scores";
import type { ModuleData } from "./modules";
import { stripRichText } from "./rich-text";

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
  /** 总体岗位匹配度 0-10 */
  match: number;
  summary: string;
  modules: ModuleDiagnosis[];
};

export type DiagnosisSnapshot = { title: string; modules: ModuleData[] };
export type DiagnosisAdoption = {
  moduleKey: string;
  suggestionIndex: number;
  value: string | string[];
  applied_at: string;
};
export type DiagnosisRecord = {
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

/** 精确读取建议的目标字段；已删除的目标返回 null，不把空值误认成不存在。 */
export function diagnosisValue(modules: ModuleData[], moduleKey: string, suggestion: DiagnosisSuggestion): string | string[] | null {
  const mod = modules.find((entry) => entry.key === moduleKey);
  if (!mod) return null;
  if (suggestion.field === "description") {
    if (!["work", "projects", "education"].includes(mod.type) || !Array.isArray(mod.content)) return null;
    const item = (mod.content as { id: string; description?: string; descriptionItems?: string[] }[]).find((it) => it.id === suggestion.itemId);
    if (!item) return null;
    if (item.description !== undefined && item.description !== null && item.description !== "") {
      return item.description;
    }
    if (Array.isArray(item.descriptionItems) && item.descriptionItems.length > 0) {
      return item.descriptionItems.join("\n");
    }
    return item.description ?? null;
  }
  if (suggestion.field === "text" && mod.type === "summary") return (mod.content as { text: string }).text;
  if (suggestion.field === "items" && mod.type === "skills") return (mod.content as { items: string[] }).items;
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
    const items = Array.isArray(mod.content) ? (mod.content as { id?: string }[]) : [];
    if (!itemId || !items.some((it) => it && typeof it === "object" && it.id === itemId)) return null;
    const draft = typeof o.draft === "string" ? o.draft.trim() : "";
    if (!draft) return null;
    return { itemId, field, reason, draft };
  }
  if (field === "text") {
    if ((mod.type !== "summary" && mod.type !== "custom") || itemId) return null;
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
  const match = Number(o.match);
  if (!Number.isFinite(match) || match < 0 || match > 10) return null;
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
  if (result.length === 0) return null;
  return { match: Math.round(match * 10) / 10, summary, modules: result };
}

/**
 * 为 LLM 诊断准备模块数据：保留模块与条目结构（key/id/label 等），
 * 将富文本 HTML（例如 <strong>、<span>、<br> 等）清洗为纯文本，
 * 避免 LLM 受到 HTML 标签干扰或将排版标签误判为简历内容缺陷。
 */
export function sanitizeModulesForDiagnosis(modules: ModuleData[]): ModuleData[] {
  return modules.map((m) => {
    if (m.type === "summary") {
      const text = (m.content as { text?: string })?.text ?? "";
      return { ...m, content: { text: stripRichText(text) } };
    }
    if (m.type === "skills") {
      const items = (m.content as { items?: string[] })?.items ?? [];
      return { ...m, content: { items: items.map((it) => (typeof it === "string" ? stripRichText(it) : it)) } };
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
        if (Array.isArray(next.subItems)) {
          next.subItems = (next.subItems as Record<string, unknown>[]).map((sub) => ({
            ...sub,
            value: typeof sub.value === "string" ? stripRichText(sub.value) : sub.value,
          }));
        }
        return next;
      });
      return { ...m, content: sanitizedContent };
    }
    return m;
  });
}

