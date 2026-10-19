import { clearEntityLlmLabels } from "./llm-label-cleanup";
import { resolveResumeVersionId } from "@/lib/resume-versions";
import { getDb, inTransaction, now } from "./db";
import type { ModuleData } from "./modules";
import { decodeHtmlEntities } from "./rich-text";

export type RiskLevel = "critical" | "high" | "medium" | "low";

export type RiskType =
  | "vague_phrase" // 假大空/宽泛无物
  | "data_suspicion" // 数据疑点/提升xxx%无基数
  | "buzzword_stuffing" // 术语概念堆砌
  | "scope_ambiguity" // 职责边界模糊
  | "logic_flaw"; // 逻辑前后矛盾

export type DefensePlan = {
  interviewerIntent: string; // 面试官真实探底意图
  standardDefense: string; // 推荐防御应答方案 (结合STAR与权衡)
  tabooMistakes: string[]; // 绝对不能踩的致命答法禁忌
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

export function normalizeScannedDefenseItem(raw: unknown, idx = 0): ScannedDefenseItem | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;

  let originalText = typeof it.originalText === "string"
    ? it.originalText.trim()
    : typeof it.original_text === "string"
    ? it.original_text.trim()
    : "";
  if (!originalText) return null;

  if (originalText.includes("&lt;") || originalText.includes("&gt;")) {
    originalText = decodeHtmlEntities(originalText);
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
    : [];
  const tabooMistakes = rawTaboo.filter((t): t is string => typeof t === "string" && t.trim().length > 0);

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
    interviewerRoast: rawRoast || "这行写得太经不起推敲了。",
    deadlyQuestions: deadlyQuestions.length > 0 ? deadlyQuestions : ["请具体阐述你在该项目中的技术细节与量化指标。"],
    defensePlan: {
      interviewerIntent: rawIntent || "考察技术落地细节与真实主导度。",
      standardDefense: rawStandard || "围绕背景、难点、指标基数与技术权衡展开阐述。",
      tabooMistakes: tabooMistakes.length > 0 ? tabooMistakes : ["避免模糊甩锅或承认完全没关注过基数指标。"],
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
  const overallRoast = rawOverall || "这份简历还有不少可以深挖的隐患点。";

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

export function saveDefenseReport(params: {
  resumeId?: number | null;
  resumeVersionId?: number | null;
  title?: string;
  sourceContent: string;
  targetRole?: string;
  riskLevel: RiskLevel;
  overallRoast: string;
  items: ScannedDefenseItem[];
}): ResumeDefenseReport {
  return inTransaction(() => {
    const db = getDb();
    const createdAt = now();
    const resumeVersionId = params.resumeId == null ? null : resolveResumeVersionId(params.resumeId, params.resumeVersionId);
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

  let items: ScannedDefenseItem[] = [];
  try {
    const rawArr = JSON.parse((row.scanned_items as string) || "[]");
    if (Array.isArray(rawArr)) {
      items = rawArr
        .map((it, idx) => normalizeScannedDefenseItem(it, idx))
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
    sourceContent: (row.source_content as string) || "",
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
}): DefenseDrillRecord {
  const db = getDb();
  const currentTime = now();

  return inTransaction(() => {
    const existing = db
      .prepare(
        "SELECT id FROM resume_defense_drills WHERE defense_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(params.defenseId, params.itemId) as { id: number } | undefined;

    if (existing) {
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
        existing.id
      );

      return {
        id: existing.id,
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

  return rows.map((r) => ({
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
  }));
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

