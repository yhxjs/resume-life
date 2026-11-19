import { clearEntityLlmLabels } from "./llm-label-cleanup";
import { resolveResumeVersionId, ResumeVersionError } from "@/lib/resume-versions";
import { loadResumeContext } from "./resumes";
import { ResumeContextError } from "./resume-errors";
import { getDb, inTransaction, now } from "./db";
import type { ModuleData } from "./modules";
import { decodeHtmlEntities } from "./rich-text";
import { hasQuestionContent, questionComparisonKey } from "./question-normalization";
import { resolveUntrustedSourceQuote } from "./prompt-safety";

export type RiskLevel = "critical" | "high" | "medium" | "low";

export type RiskType =
  | "vague_phrase" // 假大空/宽泛无物
  | "data_suspicion" // 数据疑点/提升xxx%无基数
  | "buzzword_stuffing" // 术语概念堆砌
  | "scope_ambiguity" // 职责边界模糊
  | "logic_flaw"; // 逻辑前后矛盾

export type DefensePlan = {
  interviewerIntent: string; // 追问可能核实的信息，不代表真实心理
  standardDefense: string; // 基于已知事实的练习参考
  tabooMistakes: string[]; // 应避免的失实表达
};

export type ScannedDefenseItem = {
  id: string;
  originalText: string;
  sectionHint: string;
  riskLevel: "critical" | "high" | "medium";
  riskType: RiskType;
  interviewerRoast: string;
  deadlyQuestions: string[];
  defensePlan: DefensePlan;
};

export type ResumeDefenseReport = {
  id: number;
  resumeId: number | null;
  resumeVersionId?: number | null;
  title: string;
  sourceContent: string;
  targetRole: string;
  riskLevel: RiskLevel;
  overallRoast: string;
  items: ScannedDefenseItem[];
  createdAt: string;
};

export type DefenseDrillRecord = {
  id: number;
  defenseId: number;
  itemId: string;
  question: string;
  userAnswer: string;
  interviewerRoast: string;
  defenseScore: number;
  defenseCritique: string;
  improvedAnswer: string;
  createdAt: string;
  updatedAt: string;
};

export type DefenseDrillSaveGuard = {
  sourceContent: string;
  originalText: string;
  /** 请求显式提供参考方案时，不依赖报告中的默认参考。 */
  defaultDefensePlan?: string;
  previousDrill: DefenseDrillRecord | null;
};

export class DefenseDrillSaveError extends Error {
  constructor(message: string, public readonly status: 404 | 409) {
    super(message);
    this.name = "DefenseDrillSaveError";
  }
}

/** 新生成排雷报告的文本上限；原文引文保持完整，不施加此处的展示长度约束。 */
export const RESUME_DEFENSE_OUTPUT_LIMITS = {
  overall_roast: 200, section_hint: 80, interviewer_roast: 200,
  deadly_question: 150, min_deadly_questions: 2, max_deadly_questions: 3,
  interviewer_intent: 200, standard_defense: 200,
  taboo_mistake: 120, min_taboo_mistakes: 0, max_taboo_mistakes: 3,
  max_items: 8,
} as const;

export function normalizeScannedDefenseItem(raw: unknown, idx = 0, sourceContent?: string): ScannedDefenseItem | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;

  let originalText = typeof it.originalText === "string"
    ? it.originalText.trim()
    : typeof it.original_text === "string"
    ? it.original_text.trim()
    : "";
  if (!originalText) return null;

  if (originalText.includes("&lt;") || originalText.includes("&gt;")) {
    // 原文中的实体也可能就是字面内容；优先保留已匹配的引用。
    // 仅在解码后能匹配原文，或旧记录未保存原文时兼容历史富文本编码。
    if (!sourceContent?.includes(originalText)) {
      const decoded = decodeHtmlEntities(originalText);
      if (!sourceContent?.trim() || sourceContent.includes(decoded)) originalText = decoded;
    }
  }

  const validItemLevels = ["critical", "high", "medium"] as const;
  const rawLevel = (it.riskLevel || it.risk_level) as (typeof validItemLevels)[number];
  const itemLevel = validItemLevels.includes(rawLevel) ? rawLevel : "medium";

  const validRiskTypes: RiskType[] = [
    "vague_phrase",
    "data_suspicion",
    "buzzword_stuffing",
    "scope_ambiguity",
    "logic_flaw",
  ];
  const rawType = (it.riskType || it.risk_type) as RiskType;
  const riskType: RiskType = validRiskTypes.includes(rawType) ? rawType : "vague_phrase";

  const rawQuestions = Array.isArray(it.deadlyQuestions)
    ? it.deadlyQuestions
    : Array.isArray(it.deadly_questions)
    ? it.deadly_questions
    : [];
  const deadlyQuestions = rawQuestions.filter((q): q is string => typeof q === "string" && q.trim().length > 0);

  const rawPlan = (it.defensePlan || it.defense_plan) && typeof (it.defensePlan || it.defense_plan) === "object"
    ? ((it.defensePlan || it.defense_plan) as Record<string, unknown>)
    : {};
  const rawTaboo = Array.isArray(rawPlan.tabooMistakes)
    ? rawPlan.tabooMistakes
    : Array.isArray(rawPlan.taboo_mistakes)
    ? rawPlan.taboo_mistakes
    : undefined;
  const tabooMistakes = rawTaboo?.filter((t): t is string => typeof t === "string" && t.trim().length > 0) ?? [];

  const rawIntent = typeof rawPlan.interviewerIntent === "string"
    ? rawPlan.interviewerIntent.trim()
    : typeof rawPlan.interviewer_intent === "string"
    ? rawPlan.interviewer_intent.trim()
    : "";

  const rawStandard = typeof rawPlan.standardDefense === "string"
    ? rawPlan.standardDefense.trim()
    : typeof rawPlan.standard_defense === "string"
    ? rawPlan.standard_defense.trim()
    : "";

  const rawRoast = typeof it.interviewerRoast === "string"
    ? it.interviewerRoast.trim()
    : typeof it.interviewer_roast === "string"
    ? it.interviewer_roast.trim()
    : "";

  const rawHint = typeof it.sectionHint === "string"
    ? it.sectionHint
    : typeof it.section_hint === "string"
    ? it.section_hint
    : "简历内容";

  return {
    id: typeof it.id === "string" && it.id ? it.id : `item_${idx + 1}`,
    originalText,
    sectionHint: rawHint,
    riskLevel: itemLevel,
    riskType,
    interviewerRoast: rawRoast || "旧记录未保存该条点评，请结合原文核对，不据此认定表述有问题。",
    deadlyQuestions: deadlyQuestions.length > 0 ? deadlyQuestions : ["请结合上下文解释这段表述，说明能确认的内容与待核实信息。"],
    defensePlan: {
      interviewerIntent: rawIntent || "核对这段表述的具体含义、个人职责与可确认依据。",
      standardDefense: rawStandard || "通用练习框架（旧记录未保存参考方案）：只复述能确认的事实与个人分工；记不清的信息明确说明待核实，不补造职责、数字或结果。",
      // 显式空列表表示没有具体提醒；仅为缺失或损坏的旧记录补默认值。
      tabooMistakes: tabooMistakes.length > 0 || rawTaboo?.length === 0
        ? tabooMistakes
        : ["把团队成果说成个人独立完成，或编造未经核实的数据与经历。"],
    },
  };
}

export function normalizeDefenseReport(raw: unknown): {
  riskLevel: RiskLevel;
  overallRoast: string;
  items: ScannedDefenseItem[];
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("排雷报告输出结构异常");
  }
  const obj = raw as Record<string, unknown>;

  const validLevels: RiskLevel[] = ["critical", "high", "medium", "low"];
  const rawRisk = (obj.riskLevel || obj.risk_level) as RiskLevel;
  const riskLevel: RiskLevel = validLevels.includes(rawRisk) ? rawRisk : "medium";

  const rawOverall = typeof obj.overallRoast === "string"
    ? obj.overallRoast.trim()
    : typeof obj.overall_roast === "string"
    ? obj.overall_roast.trim()
    : "";
  const overallRoast = rawOverall || "旧记录未保存整体点评，请依据原文与已有条目核对，不据此认定存在风险。";

  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items: ScannedDefenseItem[] = rawItems
    .map((item, idx) => normalizeScannedDefenseItem(item, idx))
    .filter((it): it is ScannedDefenseItem => it !== null);

  return {
    riskLevel,
    overallRoast,
    items,
  };
}

/** 新生成报告必须有完整证据与预案；兼容历史数据的默认点评不用于模型输出。 */
export function validateGeneratedDefenseReport(
  raw: unknown,
  sourceContent: string,
  sourceParts: readonly string[] = [sourceContent],
): ReturnType<typeof normalizeDefenseReport> | null {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
    Object.keys(value).every((key) => allowed.includes(key));
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && hasQuestionContent(value);
  const boundedText = (value: unknown, max: number): value is string => text(value) && value.trim().length <= max;
  const limits = RESUME_DEFENSE_OUTPUT_LIMITS;
  const texts = (value: unknown, maxItems: number, maxChars: number, minItems = 1): value is string[] =>
    Array.isArray(value) && value.length >= minItems && value.length <= maxItems && value.every((item) => boundedText(item, maxChars));
  if (!record(raw) || !hasOnlyKeys(raw, ["risk_level", "overall_roast", "items"]) ||
      !["critical", "high", "medium", "low"].includes(raw.risk_level as string) ||
      !boundedText(raw.overall_roast, limits.overall_roast) || !Array.isArray(raw.items) || raw.items.length > limits.max_items) return null;
  if ((raw.items.length === 0) !== (raw.risk_level === "low")) return null;

  const quotes = new Set<string>();
  const items: ScannedDefenseItem[] = [];
  const riskRank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  for (const [index, item] of raw.items.entries()) {
    if (!record(item) || !hasOnlyKeys(item, [
      "original_text", "section_hint", "risk_level", "risk_type", "interviewer_roast", "deadly_questions", "defense_plan",
    ]) || typeof item.original_text !== "string" || !item.original_text.trim() ||
        !boundedText(item.section_hint, limits.section_hint) || !boundedText(item.interviewer_roast, limits.interviewer_roast) ||
        !["critical", "high", "medium"].includes(item.risk_level as string) ||
        !["vague_phrase", "data_suspicion", "buzzword_stuffing", "scope_ambiguity", "logic_flaw"].includes(item.risk_type as string) ||
        !texts(item.deadly_questions, limits.max_deadly_questions, limits.deadly_question) || item.deadly_questions.length < limits.min_deadly_questions ||
        item.deadly_questions.some((question) => !hasQuestionContent(question) || !questionComparisonKey(question)) ||
        new Set(item.deadly_questions.map((question) => questionComparisonKey(question))).size !== item.deadly_questions.length ||
        !record(item.defense_plan) || !hasOnlyKeys(item.defense_plan, ["interviewer_intent", "standard_defense", "taboo_mistakes"]) ||
        !boundedText(item.defense_plan.interviewer_intent, limits.interviewer_intent) ||
        !boundedText(item.defense_plan.standard_defense, limits.standard_defense) ||
        !texts(item.defense_plan.taboo_mistakes, limits.max_taboo_mistakes, limits.taboo_mistake, limits.min_taboo_mistakes)) return null;
    const quote = resolveUntrustedSourceQuote(item.original_text.trim(), sourceContent, sourceParts);
    if (quote === null || quotes.has(quote)) return null;
    quotes.add(quote);
    // 只保存已匹配的原文；不再经过历史兼容清洗或宽松 HTML 实体解码。
    items.push({
      id: `item_${index + 1}`, originalText: quote, sectionHint: item.section_hint.trim(),
      riskLevel: item.risk_level as ScannedDefenseItem["riskLevel"], riskType: item.risk_type as RiskType,
      interviewerRoast: item.interviewer_roast.trim(), deadlyQuestions: item.deadly_questions.map((question) => question.trim()),
      defensePlan: {
        interviewerIntent: item.defense_plan.interviewer_intent.trim(),
        standardDefense: item.defense_plan.standard_defense.trim(),
        tabooMistakes: item.defense_plan.taboo_mistakes.map((mistake) => mistake.trim()),
      },
    });
  }
  const highestItemRisk = items.reduce((highest, item) =>
    riskRank[item.riskLevel] > riskRank[highest] ? item.riskLevel : highest, "low" as RiskLevel);
  if (riskRank[raw.risk_level as RiskLevel] < riskRank[highestItemRisk]) return null;
  return { riskLevel: raw.risk_level as RiskLevel, overallRoast: raw.overall_roast.trim(), items };
}

export function saveDefenseReport(params: {
  resumeId?: number | null;
  resumeVersionId?: number | null;
  title?: string;
  sourceContent: string;
  targetRole?: string;
  riskLevel: RiskLevel;
  overallRoast: string;
  items: ScannedDefenseItem[];
}, guard?: { resumeContext: string }): ResumeDefenseReport {
  return inTransaction(() => {
    const db = getDb();
    const createdAt = now();
    const resumeVersionId = params.resumeId == null ? null : resolveResumeVersionId(params.resumeId, params.resumeVersionId);
    // 模型等待期间不持锁；以实际外发职业材料复核，与报告写入共用事务。
    if (guard) {
      const conflict = "排雷使用的简历材料已变化，请核对所选版本后重新生成";
      try {
        if (params.resumeId == null || loadResumeContext(params.resumeId, resumeVersionId) !== guard.resumeContext) {
          throw new ResumeVersionError(conflict, 409);
        }
      } catch (error) {
        if (error instanceof ResumeContextError) throw new ResumeVersionError(conflict, 409);
        throw error;
      }
    }
    const title = params.title || (params.targetRole ? `${params.targetRole} - 简历排雷` : "简历逐行排雷报告");
    const targetRole = params.targetRole || "";

    const result = db
      .prepare(
        `INSERT INTO resume_defenses (resume_id, resume_version_id, title, source_content, target_role, risk_level, overall_roast, scanned_items, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.resumeId ?? null,
        resumeVersionId,
        title,
        params.sourceContent,
        targetRole,
        params.riskLevel,
        params.overallRoast,
        JSON.stringify(params.items),
        createdAt
      );

    const insertedId = Number(result.lastInsertRowid);
    return {
      id: insertedId,
      resumeId: params.resumeId ?? null,
      resumeVersionId,
      title,
      sourceContent: params.sourceContent,
      targetRole,
      riskLevel: params.riskLevel,
      overallRoast: params.overallRoast,
      items: params.items,
      createdAt,
    };
  });
}

export function getDefenseReport(id: number): ResumeDefenseReport | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM resume_defenses WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  const sourceContent = (row.source_content as string) || "";
  let items: ScannedDefenseItem[] = [];
  try {
    const rawArr = JSON.parse((row.scanned_items as string) || "[]");
    if (Array.isArray(rawArr)) {
      items = rawArr
        .map((it, idx) => normalizeScannedDefenseItem(it, idx, sourceContent))
        .filter((it): it is ScannedDefenseItem => it !== null);
    }
  } catch {
    items = [];
  }

  return {
    id: Number(row.id),
    resumeId: row.resume_id ? Number(row.resume_id) : null,
    resumeVersionId: row.resume_version_id ? Number(row.resume_version_id) : null,
    title: (row.title as string) || "",
    sourceContent,
    targetRole: (row.target_role as string) || "",
    riskLevel: (row.risk_level as RiskLevel) || "medium",
    overallRoast: (row.overall_roast as string) || "",
    items,
    createdAt: (row.created_at as string) || "",
  };
}

export function listDefenseReports(limit = 20): Array<{
  id: number;
  resumeId: number | null;
  resumeVersionId?: number | null;
  title: string;
  targetRole: string;
  riskLevel: RiskLevel;
  itemCount: number;
  createdAt: string;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, resume_id, resume_version_id, title, target_role, risk_level, scanned_items, created_at
       FROM resume_defenses ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];

  return rows.map((r) => {
    let count = 0;
    try {
      const parsed = JSON.parse((r.scanned_items as string) || "[]");
      count = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      count = 0;
    }
    return {
      id: Number(r.id),
      resumeId: r.resume_id ? Number(r.resume_id) : null,
      resumeVersionId: r.resume_version_id ? Number(r.resume_version_id) : null,
      title: (r.title as string) || "",
      targetRole: (r.target_role as string) || "",
      riskLevel: (r.risk_level as RiskLevel) || "medium",
      itemCount: count,
      createdAt: (r.created_at as string) || "",
    };
  });
}

export function saveDefenseDrill(params: {
  defenseId: number;
  itemId: string;
  question: string;
  userAnswer: string;
  interviewerRoast: string;
  defenseScore: number;
  defenseCritique: string;
  improvedAnswer: string;
}, guard?: DefenseDrillSaveGuard): DefenseDrillRecord {
  const db = getDb();
  const currentTime = now();

  return inTransaction(() => {
    const existingDrill = getDefenseDrill(params.defenseId, params.itemId);

    // 在同一 BEGIN IMMEDIATE 事务内复核实际模型背景与原演练，防止慢响应覆盖新结果。
    if (guard) {
      const report = getDefenseReport(params.defenseId);
      if (!report) throw new DefenseDrillSaveError("排雷报告已删除，请返回列表", 404);
      const item = report.items.find((entry) => entry.id === params.itemId);
      const sourceContent = report.sourceContent.trim() ? report.sourceContent : "";
      if (!item || sourceContent !== guard.sourceContent || item.originalText !== guard.originalText ||
          (guard.defaultDefensePlan !== undefined && item.defensePlan.standardDefense !== guard.defaultDefensePlan)) {
        throw new DefenseDrillSaveError("评分背景已发生变化，请刷新报告后重新评估", 409);
      }
      if (JSON.stringify(existingDrill) !== JSON.stringify(guard.previousDrill)) {
        throw new DefenseDrillSaveError("该条演练已更新，请刷新后重新评估", 409);
      }
    }

    if (existingDrill) {
      db.prepare(
        `UPDATE resume_defense_drills
         SET question = ?, user_answer = ?, interviewer_roast = ?, defense_score = ?, defense_critique = ?, improved_answer = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        params.question,
        params.userAnswer,
        params.interviewerRoast,
        params.defenseScore,
        params.defenseCritique,
        params.improvedAnswer,
        currentTime,
        existingDrill.id
      );

      return {
        id: existingDrill.id,
        defenseId: params.defenseId,
        itemId: params.itemId,
        question: params.question,
        userAnswer: params.userAnswer,
        interviewerRoast: params.interviewerRoast,
        defenseScore: params.defenseScore,
        defenseCritique: params.defenseCritique,
        improvedAnswer: params.improvedAnswer,
        createdAt: existingDrill.createdAt,
        updatedAt: currentTime,
      };
    }

    const res = db
      .prepare(
        `INSERT INTO resume_defense_drills (defense_id, item_id, question, user_answer, interviewer_roast, defense_score, defense_critique, improved_answer, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.defenseId,
        params.itemId,
        params.question,
        params.userAnswer,
        params.interviewerRoast,
        params.defenseScore,
        params.defenseCritique,
        params.improvedAnswer,
        currentTime,
        currentTime
      );

    return {
      id: Number(res.lastInsertRowid),
      defenseId: params.defenseId,
      itemId: params.itemId,
      question: params.question,
      userAnswer: params.userAnswer,
      interviewerRoast: params.interviewerRoast,
      defenseScore: params.defenseScore,
      defenseCritique: params.defenseCritique,
      improvedAnswer: params.improvedAnswer,
      createdAt: currentTime,
      updatedAt: currentTime,
    };
  });
}

export function getDefenseDrills(defenseId: number): DefenseDrillRecord[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM resume_defense_drills WHERE defense_id = ? ORDER BY id ASC")
    .all(defenseId) as Record<string, unknown>[];

  return rows.map(mapDefenseDrillRow);
}

/** 与保存路径使用相同的最新记录口径，兼容旧备份中同条目的多份记录。 */
export function getDefenseDrill(defenseId: number, itemId: string): DefenseDrillRecord | null {
  const row = getDb().prepare(
    "SELECT * FROM resume_defense_drills WHERE defense_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1"
  ).get(defenseId, itemId) as Record<string, unknown> | undefined;
  return row ? mapDefenseDrillRow(row) : null;
}

function mapDefenseDrillRow(r: Record<string, unknown>): DefenseDrillRecord {
  return {
    id: Number(r.id),
    defenseId: Number(r.defense_id),
    itemId: (r.item_id as string) || "",
    question: (r.question as string) || "",
    userAnswer: (r.user_answer as string) || "",
    interviewerRoast: (r.interviewer_roast as string) || "",
    defenseScore: Number(r.defense_score || 0),
    defenseCritique: (r.defense_critique as string) || "",
    improvedAnswer: (r.improved_answer as string) || "",
    createdAt: (r.created_at as string) || "",
    updatedAt: (r.updated_at as string) || "",
  };
}

export function formatResumeModulesToText(title: string, modules: ModuleData[]): string {
  const parts: string[] = [];
  if (title) {
    parts.push(`# ${title}`);
  }

  for (const mod of modules) {
    const label = mod.label || mod.key;
    const content = mod.content;

    if (mod.type === "basic") {
      const b = (content && typeof content === "object" ? content : {}) as Record<string, string>;
      const details = [b.name, b.phone, b.email, b.location, b.links].filter(Boolean).join(" | ");
      if (details) {
        parts.push(`## ${label}\n${details}`);
      }
    } else if (mod.type === "education") {
      const items = Array.isArray(content) ? content : [];
      const lines = items
        .map((it) => {
          const item = it as Record<string, string>;
          const time = [item.start, item.end].filter(Boolean).join(" ~ ");
          const header = [item.school, item.degree, item.field, time].filter(Boolean).join(" · ");
          return header + (item.description ? `\n${item.description}` : "");
        })
        .filter(Boolean);
      if (lines.length > 0) {
        parts.push(`## ${label}\n${lines.join("\n\n")}`);
      }
    } else if (mod.type === "work") {
      const items = Array.isArray(content) ? content : [];
      const lines = items
        .map((it) => {
          const item = it as Record<string, string>;
          const time = [item.start, item.end].filter(Boolean).join(" ~ ");
          const header = [item.company, item.title, time].filter(Boolean).join(" · ");
          return header + (item.description ? `\n${item.description}` : "");
        })
        .filter(Boolean);
      if (lines.length > 0) {
        parts.push(`## ${label}\n${lines.join("\n\n")}`);
      }
    } else if (mod.type === "projects") {
      const items = Array.isArray(content) ? content : [];
      const lines = items
        .map((it) => {
          const item = it as Record<string, string>;
          const time = [item.start, item.end].filter(Boolean).join(" ~ ");
          const header = [item.name, item.role, time].filter(Boolean).join(" · ");
          return header + (item.description ? `\n${item.description}` : "");
        })
        .filter(Boolean);
      if (lines.length > 0) {
        parts.push(`## ${label}\n${lines.join("\n\n")}`);
      }
    } else if (mod.type === "skills") {
      const s = (content && typeof content === "object" ? content : {}) as { items?: string[] };
      const items = Array.isArray(s.items) ? s.items.filter(Boolean) : [];
      if (items.length > 0) {
        parts.push(`## ${label}\n- ${items.join("\n- ")}`);
      }
    } else if (mod.type === "summary") {
      const s = (content && typeof content === "object" ? content : {}) as { text?: string };
      if (s.text) {
        parts.push(`## ${label}\n${s.text}`);
      }
    } else if (mod.type === "custom") {
      const items = Array.isArray(content) ? content : [];
      const lines = items
        .map((it) => {
          const item = it as Record<string, string>;
          const time = [item.start, item.end].filter(Boolean).join(" ~ ");
          const header = [item.title, item.subTitle, time].filter(Boolean).join(" · ");
          return header + (item.description ? `\n${item.description}` : "");
        })
        .filter(Boolean);
      if (lines.length > 0) {
        parts.push(`## ${label}\n${lines.join("\n\n")}`);
      }
    }
  }

  return parts.join("\n\n");
}

export function deleteDefenseReport(id: number): boolean {
  const db = getDb();
  return inTransaction(() => {
    clearEntityLlmLabels(db, "defense", id);
    db.prepare("DELETE FROM resume_defense_drills WHERE defense_id = ?").run(id);
    const res = db.prepare("DELETE FROM resume_defenses WHERE id = ?").run(id);
    return res.changes > 0;
  });
}

